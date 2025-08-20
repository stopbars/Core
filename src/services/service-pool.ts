// services/ServicePool.ts
import { VatsimService } from './vatsim';
import { AuthService } from './auth';
import { RoleService } from './roles';
import { CacheService } from './cache';
import { AirportService } from './airport';
import { DivisionService } from './divisions';
import { IDService } from './id';
import { PointsService } from './points';
import { PolygonService } from './polygons';
import { SupportService } from './support';
import { NotamService } from './notam';
import { ContributionService } from './contributions';
import { StorageService } from './storage';
import { GitHubService } from './github';
import { PostHogService } from './posthog';
import { FAQService } from './faqs';
import { ReleaseService } from './releases';
import { ContactService } from './contact';
import { DownloadsService } from './downloads';

export const ServicePool = (() => {
	let vatsim: VatsimService;
	let auth: AuthService;
	let roles: RoleService;
	let cache: CacheService;
	let airport: AirportService;
	let divisions: DivisionService;
	let id: IDService;
	let points: PointsService;
	let polygons: PolygonService;
	let support: SupportService;
	let notam: NotamService;
	let contributions: ContributionService;
	let storage: StorageService;
	let github: GitHubService;
	let posthog: PostHogService;
	let faqs: FAQService;
	let releases: ReleaseService;
	let contact: ContactService;
	let downloads: DownloadsService;

	return {
		getVatsim(env: Env) {
			if (!vatsim) {
				vatsim = new VatsimService(env.VATSIM_CLIENT_ID, env.VATSIM_CLIENT_SECRET);
			}
			return vatsim;
		},
		getAuth(env: Env) {
			if (!auth) {
				auth = new AuthService(env.DB, this.getVatsim(env), this.getPostHog(env));
			}
			return auth;
		},
		getRoles(env: Env) {
			if (!roles) {
				roles = new RoleService(env.DB);
			}
			return roles;
		},
		getCache(env: Env) {
			if (!cache) {
				cache = new CacheService(env);
			}
			return cache;
		},
		getAirport(env: Env) {
			if (!airport) {
				airport = new AirportService(env.DB, env.AIRPORTDB_API_KEY, this.getPostHog(env));
			}
			return airport;
		},
		getDivisions(env: Env) {
			if (!divisions) {
				divisions = new DivisionService(env.DB, this.getPostHog(env));
			}
			return divisions;
		},
		getID(env: Env) {
			if (!id) {
				id = new IDService(env.DB);
			}
			return id;
		},
		getPoints(env: Env) {
			if (!points) {
				points = new PointsService(env.DB, this.getID(env), this.getDivisions(env), this.getAuth(env), this.getPostHog(env));
			}
			return points;
		},
		getPolygons(env: Env) {
			if (!polygons) {
				polygons = new PolygonService(env.DB);
			}
			return polygons;
		},
		getSupport(env: Env) {
			if (!support) {
				support = new SupportService(env.DB);
			}
			return support;
		},
		getNotam(env: Env) {
			if (!notam) {
				notam = new NotamService(env.DB);
			}
			return notam;
		},
		getContributions(env: Env) {
			if (!contributions) {
				contributions = new ContributionService(
					env.DB,
					this.getRoles(env),
					env.AIRPORTDB_API_KEY,
					env.BARS_STORAGE,
					this.getPostHog(env),
				);
			}
			return contributions;
		},
		getStorage(env: Env) {
			if (!storage) {
				storage = new StorageService(env.BARS_STORAGE);
			}
			return storage;
		},
		getGitHub(env: Env) {
			if (!github) {
				github = new GitHubService();
			}
			return github;
		},
		getPostHog(env: Env) {
			if (!posthog) {
				posthog = new PostHogService(env);
			}
			return posthog;
		},
		getFAQs(env: Env) {
			if (!faqs) {
				faqs = new FAQService(env.DB);
			}
			return faqs;
		},
		getReleases(env: Env) {
			if (!releases) {
				releases = new ReleaseService(env.DB, this.getStorage(env));
			}
			return releases;
		},
		getContact(env: Env) {
			if (!contact) {
				contact = new ContactService(env.DB);
			}
			return contact;
		},
		getDownloads(env: Env) {
			if (!downloads) {
				downloads = new DownloadsService(env.DB);
			}
			return downloads;
		},
	};
})();
