package repos

import (
	"fmt"
	"net/url"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/goware/urlx"
	multierror "github.com/hashicorp/go-multierror"
	"github.com/pkg/errors"
	"github.com/sourcegraph/sourcegraph/pkg/api"
	"github.com/sourcegraph/sourcegraph/pkg/extsvc/awscodecommit"
	"github.com/sourcegraph/sourcegraph/pkg/extsvc/bitbucketserver"
	"github.com/sourcegraph/sourcegraph/pkg/extsvc/github"
	"github.com/sourcegraph/sourcegraph/pkg/extsvc/gitlab"
	"github.com/sourcegraph/sourcegraph/pkg/extsvc/gitolite"
	"github.com/sourcegraph/sourcegraph/pkg/jsonc"
	"github.com/sourcegraph/sourcegraph/schema"
	"github.com/xeipuuv/gojsonschema"
)

// An ExternalService is defines a Source that yields Repos.
type ExternalService struct {
	ID          int64
	Kind        string
	DisplayName string
	Config      string
	CreatedAt   time.Time
	UpdatedAt   time.Time
	DeletedAt   time.Time
}

// URN returns a unique resource identifier of this external service,
// used as the key in a repo's Sources map as well as the SourceInfo ID.
func (e *ExternalService) URN() string {
	return "extsvc:" + strings.ToLower(e.Kind) + ":" + strconv.FormatInt(e.ID, 10)
}

// IsDeleted returns true if the external service is deleted.
func (e *ExternalService) IsDeleted() bool { return !e.DeletedAt.IsZero() }

// Update updates ExternalService r with the fields from the given newer ExternalService n,
// returning true if modified.
func (e *ExternalService) Update(n *ExternalService) (modified bool) {
	if e.ID != n.ID {
		return false
	}

	if !strings.EqualFold(e.Kind, n.Kind) {
		e.Kind, modified = strings.ToUpper(n.Kind), true
	}

	if e.DisplayName != n.DisplayName {
		e.DisplayName, modified = n.DisplayName, true
	}

	if e.Config != n.Config {
		e.Config, modified = n.Config, true
	}

	if !e.UpdatedAt.Equal(n.UpdatedAt) {
		e.UpdatedAt, modified = n.UpdatedAt, true
	}

	if !e.DeletedAt.Equal(n.DeletedAt) {
		e.DeletedAt, modified = n.DeletedAt, true
	}

	return modified
}

// Configuration returns the external service config.
func (e ExternalService) Configuration() (cfg interface{}, _ error) {
	switch strings.ToLower(e.Kind) {
	case "awscodecommit":
		cfg = &schema.AWSCodeCommitConnection{}
	case "bitbucketserver":
		cfg = &schema.BitbucketServerConnection{}
	case "github":
		cfg = &schema.GitHubConnection{}
	case "gitlab":
		cfg = &schema.GitLabConnection{}
	case "gitolite":
		cfg = &schema.GitoliteConnection{}
	case "phabricator":
		cfg = &schema.PhabricatorConnection{}
	case "other":
		cfg = &schema.OtherExternalServiceConnection{}
	default:
		return nil, fmt.Errorf("unknown external service kind %q", e.Kind)
	}
	return cfg, jsonc.Unmarshal(e.Config, cfg)
}

// Exclude changes the configuration of an external service to exclude the given
// repos from being synced.
func (e *ExternalService) Exclude(rs ...*Repo) error {
	switch strings.ToLower(e.Kind) {
	case "github":
		return e.excludeGithubRepos(rs...)
	case "gitlab":
		return e.excludeGitLabRepos(rs...)
	case "bitbucketserver":
		return e.excludeBitbucketServerRepos(rs...)
	case "awscodecommit":
		return e.excludeAWSCodeCommitRepos(rs...)
	case "gitolite":
		return e.excludeGitoliteRepos(rs...)
	case "other":
		return e.excludeOtherRepos(rs...)
	default:
		return errors.Errorf("external service kind %q doesn't have an exclude list", e.Kind)
	}
}

// excludeOtherRepos changes the configuration of an OTHER external service to exclude
// the given repos.
func (e *ExternalService) excludeOtherRepos(rs ...*Repo) error {
	if len(rs) == 0 {
		return nil
	}

	return e.config("other", func(v interface{}) (string, interface{}, error) {
		c := v.(*schema.OtherExternalServiceConnection)

		var base *url.URL
		if c.Url != "" {
			var err error
			if base, err = url.Parse(c.Url); err != nil {
				return "", nil, err
			}
		}

		set := make(map[string]bool, len(c.Repos))
		for _, name := range c.Repos {
			if name != "" {
				u, err := otherRepoCloneURL(base, name)
				if err != nil {
					return "", nil, err
				}

				if name = u.String(); base != nil {
					name = nameWithOwner(name)
				}

				set[name] = true
			}
		}

		for _, r := range rs {
			if r.ExternalRepo.ServiceType != "other" {
				continue
			}

			u, err := url.Parse(r.ExternalRepo.ServiceID)
			if err != nil {
				return "", nil, err
			}

			name := u.Scheme + "://" + r.Name
			if base != nil {
				name = nameWithOwner(r.Name)
			}

			delete(set, name)
		}

		repos := make([]string, 0, len(set))
		for name := range set {
			repos = append(repos, name)
		}

		sort.Strings(repos)

		return "repos", repos, nil
	})
}

// excludeGitLabRepos changes the configuration of a GitLab external service to exclude the
// given repos from being synced.
func (e *ExternalService) excludeGitLabRepos(rs ...*Repo) error {
	if len(rs) == 0 {
		return nil
	}

	return e.config("gitlab", func(v interface{}) (string, interface{}, error) {
		c := v.(*schema.GitLabConnection)
		set := make(map[string]bool, len(c.Exclude)*2)
		for _, ex := range c.Exclude {
			if ex.Id != 0 {
				set[strconv.Itoa(ex.Id)] = true
			}

			if ex.Name != "" {
				set[strings.ToLower(ex.Name)] = true
			}
		}

		for _, r := range rs {
			p, ok := r.Metadata.(*gitlab.Project)
			if !ok {
				continue
			}

			name := p.PathWithNamespace
			id := strconv.Itoa(p.ID)

			if !set[name] && !set[id] {
				c.Exclude = append(c.Exclude, &schema.ExcludedGitLabProject{
					Name: name,
					Id:   p.ID,
				})

				if id != "" {
					set[id] = true
				}

				if name != "" {
					set[name] = true
				}
			}
		}

		return "exclude", c.Exclude, nil
	})
}

// excludeBitbucketServerRepos changes the configuration of a BitbucketServer external service to exclude the
// given repos from being synced.
func (e *ExternalService) excludeBitbucketServerRepos(rs ...*Repo) error {
	if len(rs) == 0 {
		return nil
	}

	return e.config("bitbucketserver", func(v interface{}) (string, interface{}, error) {
		c := v.(*schema.BitbucketServerConnection)
		set := make(map[string]bool, len(c.Exclude)*2)
		for _, ex := range c.Exclude {
			if ex.Id != 0 {
				set[strconv.Itoa(ex.Id)] = true
			}

			if ex.Name != "" {
				set[strings.ToLower(ex.Name)] = true
			}
		}

		for _, r := range rs {
			repo, ok := r.Metadata.(*bitbucketserver.Repo)
			if !ok {
				continue
			}

			id := strconv.Itoa(repo.ID)

			// The names in the exclude list do not abide by the
			// repositoryPathPattern setting. They have a fixed format.
			name := repo.Slug
			if repo.Project != nil {
				name = repo.Project.Key + "/" + name
			}

			if !set[name] && !set[id] {
				c.Exclude = append(c.Exclude, &schema.ExcludedBitbucketServerRepo{
					Name: name,
					Id:   repo.ID,
				})

				if id != "" {
					set[id] = true
				}

				if name != "" {
					set[name] = true
				}
			}
		}

		return "exclude", c.Exclude, nil
	})
}

// excludeGitoliteRepos changes the configuration of a Gitolite external service to exclude the
// given repos from being synced.
func (e *ExternalService) excludeGitoliteRepos(rs ...*Repo) error {
	if len(rs) == 0 {
		return nil
	}

	return e.config("gitolite", func(v interface{}) (string, interface{}, error) {
		c := v.(*schema.GitoliteConnection)
		set := make(map[string]bool, len(c.Exclude))
		for _, ex := range c.Exclude {
			if ex.Name != "" {
				set[ex.Name] = true
			}
		}

		for _, r := range rs {
			repo, ok := r.Metadata.(*gitolite.Repo)
			if ok && repo.Name != "" && !set[repo.Name] {
				c.Exclude = append(c.Exclude, &schema.ExcludedGitoliteRepo{Name: repo.Name})
				set[repo.Name] = true
			}
		}

		return "exclude", c.Exclude, nil
	})
}

// excludeGithubRepos changes the configuration of a Github external service to exclude the
// given repos from being synced.
func (e *ExternalService) excludeGithubRepos(rs ...*Repo) error {
	if len(rs) == 0 {
		return nil
	}

	return e.config("github", func(v interface{}) (string, interface{}, error) {
		c := v.(*schema.GitHubConnection)
		set := make(map[string]bool, len(c.Exclude)*2)
		for _, ex := range c.Exclude {
			if ex.Id != "" {
				set[ex.Id] = true
			}

			if ex.Name != "" {
				set[strings.ToLower(ex.Name)] = true
			}
		}

		for _, r := range rs {
			repo, ok := r.Metadata.(*github.Repository)
			if !ok {
				continue
			}

			id := repo.ID
			name := repo.NameWithOwner

			if !set[name] && !set[id] {
				c.Exclude = append(c.Exclude, &schema.ExcludedGitHubRepo{
					Name: name,
					Id:   id,
				})

				if id != "" {
					set[id] = true
				}

				if name != "" {
					set[name] = true
				}
			}
		}

		return "exclude", c.Exclude, nil
	})
}

// excludeAWSCodeCommitRepos changes the configuration of a AWS CodeCommit
// external service to exclude the given repos from being synced.
func (e *ExternalService) excludeAWSCodeCommitRepos(rs ...*Repo) error {
	if len(rs) == 0 {
		return nil
	}

	return e.config("awscodecommit", func(v interface{}) (string, interface{}, error) {
		c := v.(*schema.AWSCodeCommitConnection)
		set := make(map[string]bool, len(c.Exclude)*2)
		for _, ex := range c.Exclude {
			if ex.Id != "" {
				set[ex.Id] = true
			}

			if ex.Name != "" {
				set[strings.ToLower(ex.Name)] = true
			}
		}

		for _, r := range rs {
			repo, ok := r.Metadata.(*awscodecommit.Repository)
			if !ok {
				continue
			}

			id := repo.ID
			name := repo.Name

			if !set[name] && !set[id] {
				c.Exclude = append(c.Exclude, &schema.ExcludedAWSCodeCommitRepo{
					Name: name,
					Id:   id,
				})

				if id != "" {
					set[id] = true
				}

				if name != "" {
					set[name] = true
				}
			}
		}

		return "exclude", c.Exclude, nil
	})
}

func nameWithOwner(name string) string {
	u, _ := urlx.Parse(name)
	if u != nil {
		name = strings.TrimPrefix(u.Path, "/")
	}
	return strings.ToLower(name)
}

func (e *ExternalService) config(kind string, opt func(c interface{}) (string, interface{}, error)) error {
	if strings.ToLower(e.Kind) != kind {
		return fmt.Errorf("config: unexpected external service kind %q", e.Kind)
	}

	c, err := e.Configuration()
	if err != nil {
		return errors.Wrap(err, "config")
	}

	path, val, err := opt(c)
	if err != nil {
		return errors.Wrap(err, "config")
	}

	if !reflect.ValueOf(val).IsNil() {
		edited, err := jsonc.Edit(e.Config, val, strings.Split(path, ".")...)
		if err != nil {
			return errors.Wrap(err, "edit")
		}
		e.Config = edited
	}

	return e.validateConfig()
}

func (e ExternalService) schema() string {
	switch strings.ToLower(e.Kind) {
	case "awscodecommit":
		return schema.AWSCodeCommitSchemaJSON
	case "bitbucketserver":
		return schema.BitbucketServerSchemaJSON
	case "github":
		return schema.GitHubSchemaJSON
	case "gitlab":
		return schema.GitLabSchemaJSON
	case "gitolite":
		return schema.GitoliteSchemaJSON
	case "phabricator":
		return schema.PhabricatorSchemaJSON
	case "other":
		return schema.OtherExternalServiceSchemaJSON
	default:
		return ""
	}
}

// validateConfig validates the config of an external service
// against its JSON schema.
func (e ExternalService) validateConfig() error {
	sl := gojsonschema.NewSchemaLoader()
	sc, err := sl.Compile(gojsonschema.NewStringLoader(e.schema()))
	if err != nil {
		return errors.Wrapf(err, "failed to compile schema for external service of kind %q", e.Kind)
	}

	normalized, err := jsonc.Parse(e.Config)
	if err != nil {
		return errors.Wrapf(err, "failed to normalize JSON")
	}

	res, err := sc.Validate(gojsonschema.NewBytesLoader(normalized))
	if err != nil {
		return errors.Wrap(err, "failed to validate config against schema")
	}

	errs := new(multierror.Error)
	for _, err := range res.Errors() {
		errs = multierror.Append(errs, errors.New(err.String()))
	}

	return errs.ErrorOrNil()
}

// Clone returns a clone of the given external service.
func (e *ExternalService) Clone() *ExternalService {
	clone := *e
	return &clone
}

// Apply applies the given functional options to the ExternalService.
func (e *ExternalService) Apply(opts ...func(*ExternalService)) {
	if e == nil {
		return
	}

	for _, opt := range opts {
		opt(e)
	}
}

// With returns a clone of the given repo with the given functional options applied.
func (e *ExternalService) With(opts ...func(*ExternalService)) *ExternalService {
	clone := e.Clone()
	clone.Apply(opts...)
	return clone
}

// Repo represents a source code repository stored in Sourcegraph.
type Repo struct {
	// The internal Sourcegraph repo ID.
	ID uint32
	// Name is the name for this repository (e.g., "github.com/user/repo"). It
	// is the same as URI, unless the user configures a non-default
	// repositoryPathPattern.
	//
	// Previously, this was called RepoURI.
	Name string
	// URI is the full name for this repository (e.g.,
	// "github.com/user/repo"). See the documentation for the Name field.
	URI string
	// Description is a brief description of the repository.
	Description string
	// Language is the primary programming language used in this repository.
	Language string
	// Fork is whether this repository is a fork of another repository.
	Fork bool
	// Enabled is whether the repository is enabled. Disabled repositories are
	// not accessible by users (except site admins).
	Enabled bool
	// Archived is whether the repository has been archived.
	Archived bool
	// CreatedAt is when this repository was created on Sourcegraph.
	CreatedAt time.Time
	// UpdatedAt is when this repository's metadata was last updated on Sourcegraph.
	UpdatedAt time.Time
	// DeletedAt is when this repository was soft-deleted from Sourcegraph.
	DeletedAt time.Time
	// ExternalRepo identifies this repository by its ID on the external service where it resides (and the external
	// service itself).
	ExternalRepo api.ExternalRepoSpec
	// Sources identifies all the repo sources this Repo belongs to.
	Sources map[string]*SourceInfo
	// Metadata contains the raw source code host JSON metadata.
	Metadata interface{}
}

// A SourceInfo represents a source a Repo belongs to (such as an external service).
type SourceInfo struct {
	ID       string
	CloneURL string
}

// ExternalServiceID returns the ID of the external service this
// SourceInfo refers to.
func (i SourceInfo) ExternalServiceID() int64 {
	ps := strings.SplitN(i.ID, ":", 3)
	if len(ps) != 3 {
		return -1
	}

	id, err := strconv.ParseInt(ps[2], 10, 64)
	if err != nil {
		return -1
	}

	return id
}

// CloneURLs returns all the clone URLs this repo is clonable from.
func (r *Repo) CloneURLs() []string {
	urls := make([]string, 0, len(r.Sources))
	for _, src := range r.Sources {
		if src != nil && src.CloneURL != "" {
			urls = append(urls, src.CloneURL)
		}
	}
	return urls
}

// ExternalServiceIDs returns the IDs of the external services this
// repo belongs to.
func (r *Repo) ExternalServiceIDs() []int64 {
	ids := make([]int64, 0, len(r.Sources))
	for _, src := range r.Sources {
		ids = append(ids, src.ExternalServiceID())
	}
	return ids
}

// IsDeleted returns true if the repo is deleted.
func (r *Repo) IsDeleted() bool { return !r.DeletedAt.IsZero() }

// Update updates Repo r with the fields from the given newer Repo n,
// returning true if modified.
func (r *Repo) Update(n *Repo) (modified bool) {
	if !r.ExternalRepo.Equal(&n.ExternalRepo) && r.Name != n.Name {
		return false
	}

	if r.Name != n.Name {
		r.Name, modified = n.Name, true
	}

	if r.URI != n.URI {
		r.URI, modified = n.URI, true
	}

	if r.Description != n.Description {
		r.Description, modified = n.Description, true
	}

	if r.Language != n.Language {
		r.Language, modified = n.Language, true
	}

	if n.ExternalRepo != (api.ExternalRepoSpec{}) &&
		!r.ExternalRepo.Equal(&n.ExternalRepo) {
		r.ExternalRepo, modified = n.ExternalRepo, true
	}

	if r.Archived != n.Archived {
		r.Archived, modified = n.Archived, true
	}

	if r.Fork != n.Fork {
		r.Fork, modified = n.Fork, true
	}

	if !reflect.DeepEqual(r.Sources, n.Sources) {
		r.Sources, modified = n.Sources, true
	}

	if !reflect.DeepEqual(r.Metadata, n.Metadata) {
		r.Metadata, modified = n.Metadata, true
	}

	return modified
}

// Clone returns a clone of the given repo.
func (r *Repo) Clone() *Repo {
	if r == nil {
		return nil
	}
	clone := *r
	if r.Sources != nil {
		clone.Sources = make(map[string]*SourceInfo, len(r.Sources))
		for k, v := range r.Sources {
			clone.Sources[k] = v
		}
	}
	return &clone
}

// Apply applies the given functional options to the Repo.
func (r *Repo) Apply(opts ...func(*Repo)) {
	if r == nil {
		return
	}

	for _, opt := range opts {
		opt(r)
	}
}

// With returns a clone of the given repo with the given functional options applied.
func (r *Repo) With(opts ...func(*Repo)) *Repo {
	clone := r.Clone()
	clone.Apply(opts...)
	return clone
}

// Less compares Repos by the important fields (fields with constraints in our
// DB). Additionally it will compare on Sources to give a deterministic order
// on repos returned from a sourcer.
//
// NewDiff relies on Less to deterministically decide on the order to merge
// repositories, as well as which repository to keep on conflicts.
//
// Context on using other fields such as timestamps to order/resolve
// conflicts: We only want to rely on values that have constraints in our
// database. Tmestamps have the following downsides:
//
//   - We need to assume the upstream codehost has reasonable values for them
//   - Not all codehosts set them to relevant values (eg gitolite or other)
//   - They could change often for codehosts that do set them.
func (r *Repo) Less(s *Repo) bool {
	if r.ID != s.ID {
		return r.ID < s.ID
	}
	if r.Name != s.Name {
		return r.Name < s.Name
	}
	if cmp := r.ExternalRepo.Compare(s.ExternalRepo); cmp != 0 {
		return cmp == -1
	}

	return sortedSliceLess(sourcesKeys(r.Sources), sourcesKeys(s.Sources))
}

func sourcesKeys(m map[string]*SourceInfo) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// sortedSliceLess returns true if a < b
func sortedSliceLess(a, b []string) bool {
	for i, v := range a {
		if i == len(b) {
			return false
		}
		if v != b[i] {
			return v < b[i]
		}
	}
	return true
}

// Repos is an utility type with convenience methods for operating on lists of Repos.
type Repos []*Repo

// Names returns the list of names from all Repos.
func (rs Repos) Names() []string {
	names := make([]string, len(rs))
	for i := range rs {
		names[i] = rs[i].Name
	}
	return names
}

// Kinds returns the unique set of kinds from all Repos.
func (rs Repos) Kinds() (kinds []string) {
	set := map[string]bool{}
	for _, r := range rs {
		kind := strings.ToUpper(r.ExternalRepo.ServiceType)
		if !set[kind] {
			kinds = append(kinds, kind)
			set[kind] = true
		}
	}
	return kinds
}

// ExternalRepos returns the list of set ExternalRepoSpecs from all Repos.
func (rs Repos) ExternalRepos() []api.ExternalRepoSpec {
	specs := make([]api.ExternalRepoSpec, 0, len(rs))
	for _, r := range rs {
		if r.ExternalRepo.IsSet() {
			specs = append(specs, r.ExternalRepo)
		}
	}
	return specs
}

func (rs Repos) Len() int {
	return len(rs)
}

func (rs Repos) Swap(i, j int) {
	rs[i], rs[j] = rs[j], rs[i]
}

func (rs Repos) Less(i, j int) bool {
	return rs[i].Less(rs[j])
}

// Concat adds the given Repos to the end of rs.
func (rs *Repos) Concat(others ...Repos) {
	for _, o := range others {
		*rs = append(*rs, o...)
	}
}

// Clone returns a clone of Repos.
func (rs Repos) Clone() Repos {
	o := make(Repos, 0, len(rs))
	for _, r := range rs {
		o = append(o, r.Clone())
	}
	return o
}

// Apply applies the given functional options to the Repo.
func (rs Repos) Apply(opts ...func(*Repo)) {
	for _, r := range rs {
		r.Apply(opts...)
	}
}

// With returns a clone of the given repos with the given functional options applied.
func (rs Repos) With(opts ...func(*Repo)) Repos {
	clone := rs.Clone()
	clone.Apply(opts...)
	return clone
}

// Filter returns all the Repos that match the given predicate.
func (rs Repos) Filter(pred func(*Repo) bool) (fs Repos) {
	for _, r := range rs {
		if pred(r) {
			fs = append(fs, r)
		}
	}
	return fs
}

// ExternalServices is an utility type with
// convenience methods for operating on lists of ExternalServices.
type ExternalServices []*ExternalService

// DisplayNames returns the list of display names from all ExternalServices.
func (es ExternalServices) DisplayNames() []string {
	names := make([]string, len(es))
	for i := range es {
		names[i] = es[i].DisplayName
	}
	return names
}

// Kinds returns the unique set of Kinds in the given external services list.
func (es ExternalServices) Kinds() (kinds []string) {
	set := make(map[string]bool, len(es))
	for _, e := range es {
		if !set[e.Kind] {
			kinds = append(kinds, e.Kind)
			set[e.Kind] = true
		}
	}
	return kinds
}

// URNs returns the list of URNs from all ExternalServices.
func (es ExternalServices) URNs() []string {
	urns := make([]string, len(es))
	for i := range es {
		urns[i] = es[i].URN()
	}
	return urns
}

func (es ExternalServices) Len() int {
	return len(es)
}

func (es ExternalServices) Swap(i, j int) {
	es[i], es[j] = es[j], es[i]
}

func (es ExternalServices) Less(i, j int) bool {
	return es[i].ID < es[j].ID
}

// Clone returns a clone of the given external services.
func (es ExternalServices) Clone() ExternalServices {
	o := make(ExternalServices, 0, len(es))
	for _, r := range es {
		o = append(o, r.Clone())
	}
	return o
}

// Apply applies the given functional options to the ExternalService.
func (es ExternalServices) Apply(opts ...func(*ExternalService)) {
	for _, r := range es {
		r.Apply(opts...)
	}
}

// With returns a clone of the given external services with the given functional options applied.
func (es ExternalServices) With(opts ...func(*ExternalService)) ExternalServices {
	clone := es.Clone()
	clone.Apply(opts...)
	return clone
}
