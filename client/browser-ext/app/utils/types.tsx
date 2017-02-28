/**
 * PhabUrl represents the state contained in a Phabricator URL.
 * PhabDiffusionUrl is the page state for code reading. 
 * PhabDifferentialUrl is the page state for pull requests i.e. diffusion.
 */
export interface PhabUrl {
	mode: PhabricatorMode;
}

export interface PhabDiffusionUrl extends PhabUrl {
	repoURI: string;
	branch: string;
	path: string;
	rev: string;
}

export interface PhabDifferentialUrl extends PhabUrl {
	differentialId: string;
	baseBranch: string;
	baseRepoURI: string;
	headBranch: string;
	headRepoURI: string;
}

export interface PhabRevisionUrl extends PhabUrl {
	repoUri: string;
	parentRev: string;
	childRev: string;
}

export enum PhabricatorMode {
	Diffusion = 1, // 
	Differential, // 
	Revision, // 
}

export enum Domain {
	GITHUB,
	SGDEV_PHABRICATOR,
	SOURCEGRAPH,
}

export interface CodeCell {
	cell: HTMLElement;
	line: number;
	isAddition?: boolean; // for diff views
	isDeletion?: boolean; // for diff views
}

export interface PhabricatorCodeCell extends CodeCell {
	isLeftColumnInSplit: boolean;
}

export interface GitHubURLData {
	user?: string;
	repo?: string;
	repoURI?: string;
	rev?: string;
	path?: string;
	isDelta?: boolean;
	isPullRequest?: boolean;
	isCommit?: boolean;
}
