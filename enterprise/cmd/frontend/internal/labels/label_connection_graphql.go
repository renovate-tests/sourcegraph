package labels

import (
	"context"

	"github.com/graph-gophers/graphql-go"
	"github.com/sourcegraph/sourcegraph/cmd/frontend/graphqlbackend"
	"github.com/sourcegraph/sourcegraph/cmd/frontend/graphqlbackend/graphqlutil"
)

func (GraphQLResolver) LabelsFor(ctx context.Context, labelable graphql.ID, arg *graphqlutil.ConnectionArgs) (graphqlbackend.LabelConnection, error) {
	// 🚨 SECURITY: Any viewer can add/remove labels to/from a thread.
	thread, err := graphqlbackend.DiscussionThreadByID(ctx, labelable)
	if err != nil {
		return nil, err
	}

	list, err := dbLabelsObjects{}.List(ctx, dbLabelsObjectsListOptions{ThreadID: thread.DBID()})
	if err != nil {
		return nil, err
	}

	// 🚨 SECURITY: Only organization members and site admins may view labels in an
	// organization. The labelByID function performs this check.
	//
	// TODO!(sqs): This is weird because anyone can add a private-org label to a public thread and
	// cause everyone else viewing it to get a permissions error. Need to rethink thread and label
	// permissions.
	labels := make([]*gqlLabel, len(list))
	for i, a := range list {
		label, err := labelByDBID(ctx, a.Label)
		if err != nil {
			return nil, err
		}
		labels[i] = label
	}
	return &labelConnection{arg: arg, labels: labels}, nil
}

type labelConnection struct {
	arg    *graphqlutil.ConnectionArgs
	labels []*gqlLabel
}

func (r *labelConnection) Nodes(ctx context.Context) ([]graphqlbackend.Label, error) {
	labels := r.labels
	if first := r.arg.First; first != nil && len(labels) > int(*first) {
		labels = labels[:int(*first)]
	}

	labels2 := make([]graphqlbackend.Label, len(labels))
	for i, l := range labels {
		labels2[i] = l
	}
	return labels2, nil
}

func (r *labelConnection) TotalCount(ctx context.Context) (int32, error) {
	return int32(len(r.labels)), nil
}

func (r *labelConnection) PageInfo(ctx context.Context) (*graphqlutil.PageInfo, error) {
	return graphqlutil.HasNextPage(r.arg.First != nil && int(*r.arg.First) < len(r.labels)), nil
}
