/**
 * GitHub service for fetching contributor and repository information
 */

interface GitHubContributor {
    id: number;
    login: string;
    avatar_url: string;
    html_url: string;
    type: string;
    contributions: number;
    repositories: {
        name: string;
        contributions: number;
    }[];
}

interface GitHubRepository {
    name: string;
    full_name: string;
    html_url: string;
    description: string | null;
    stargazers_count: number;
    language: string | null;
    private: boolean;
    created_at: string;
    updated_at: string;
}

interface GitHubContributorResponse {
    id: number;
    login: string;
    avatar_url: string;
    html_url: string;
    type: string;
    contributions: number;
}

interface ContributorsData {
    contributors: GitHubContributor[];
    repositories: {
        name: string;
        fullName: string;
        url: string;
        description: string | null;
        stars: number;
        language: string | null;
        contributorCount: number;
        createdAt: string;
        updatedAt: string;
    }[];
    statistics: {
        totalContributors: number;
        totalRepositories: number;
        totalContributions: number;
    };
}

export class GitHubService {
    private readonly GITHUB_ORG = 'stopbars';

    constructor() { }

    /**
     * Get all public repositories for the organization
     */
    private async getOrganizationRepositories(): Promise<GitHubRepository[]> {
        const repos: GitHubRepository[] = [];
        let page = 1;
        const perPage = 100;

        while (true) {
            const res = await fetch(`https://api.github.com/orgs/${this.GITHUB_ORG}/repos?page=${page}&per_page=${perPage}&type=public`, {
                headers: {
                    "User-Agent": "BARS-API",
                    "Accept": "application/vnd.github.v3+json",
                },
            });

            if (!res.ok) {
                throw new Error(`Failed to fetch GitHub org repos: ${res.status}`);
            }

            const pageRepos: GitHubRepository[] = await res.json();

            if (pageRepos.length === 0) {
                break;
            }

            repos.push(...pageRepos);

            if (pageRepos.length < perPage) {
                break;
            }

            page++;
        }

        return repos;
    }

    /**
     * Get contributors for a specific repository
     */
    private async getRepositoryContributors(repoFullName: string): Promise<GitHubContributorResponse[]> {
        try {
            const res = await fetch(`https://api.github.com/repos/${repoFullName}/contributors?per_page=100`, {
                headers: {
                    "User-Agent": "BARS-API",
                    "Accept": "application/vnd.github.v3+json",
                },
            });

            if (!res.ok) {
                if (res.status === 404) {
                    // Repository might not exist or be accessible, skip it
                    return [];
                }
                throw new Error(`Failed to fetch GitHub contributors: ${res.status}`);
            }

            const contributors: GitHubContributorResponse[] = await res.json();
            return contributors || [];
        } catch (error) {
            console.error(`Error fetching contributors for ${repoFullName}:`, error);
            return [];
        }
    }

    /**
     * Get all contributors across all organization repositories
     */
    async getAllContributors(): Promise<ContributorsData> {
        const allContributors = new Map<number, GitHubContributor>();
        const repoData: ContributorsData['repositories'] = [];

        // Get all organization repositories
        const orgRepos = await this.getOrganizationRepositories();

        // Fetch contributors from each repository
        for (const repoInfo of orgRepos) {
            try {
                // Skip private repositories (should already be filtered but double-check)
                if (repoInfo.private) {
                    continue;
                }

                const repoContributors = await this.getRepositoryContributors(repoInfo.full_name);

                repoData.push({
                    name: repoInfo.name,
                    fullName: repoInfo.full_name,
                    url: repoInfo.html_url,
                    description: repoInfo.description,
                    stars: repoInfo.stargazers_count,
                    language: repoInfo.language,
                    contributorCount: repoContributors.length,
                    createdAt: repoInfo.created_at,
                    updatedAt: repoInfo.updated_at,
                });

                // Merge contributors (avoid duplicates)
                repoContributors.forEach(contributor => {
                    if (contributor.type === 'User') { // Exclude bots
                        if (allContributors.has(contributor.id)) {
                            // Add contributions from this repo
                            const existing = allContributors.get(contributor.id)!;
                            existing.contributions += contributor.contributions;
                            existing.repositories.push({
                                name: repoInfo.name,
                                contributions: contributor.contributions,
                            });
                        } else {
                            // New contributor
                            allContributors.set(contributor.id, {
                                ...contributor,
                                repositories: [{
                                    name: repoInfo.name,
                                    contributions: contributor.contributions,
                                }],
                            });
                        }
                    }
                });
            } catch (err) {
                console.error(`Error fetching ${repoInfo.full_name}:`, err);
            }
        }

        // Convert Map to Array and sort by contributions
        const contributorList = Array.from(allContributors.values())
            .sort((a, b) => b.contributions - a.contributions);

        // Sort repositories by stars
        repoData.sort((a, b) => b.stars - a.stars);

        const totalContributions = contributorList.reduce((sum, contributor) => sum + contributor.contributions, 0);

        return {
            contributors: contributorList,
            repositories: repoData,
            statistics: {
                totalContributors: contributorList.length,
                totalRepositories: repoData.length,
                totalContributions,
            },
        };
    }
}
