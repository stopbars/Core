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
import { VatSysProfileGeneratorService } from './vatsys-profile-generator';
import { VatSysProfilesService } from './vatsys-profiles';

export const ServicePool = (() => {
	let vatsim: VatsimService;
	let cache: CacheService;
	let id: IDService;
	let storage: StorageService;
	let github: GitHubService;
	let posthog: PostHogService;
	let vatsysProfiles: VatSysProfilesService;

	return {
		getVatsim(env: Env) {
			if (!vatsim) {
				vatsim = new VatsimService(env.VATSIM_CLIENT_ID, env.VATSIM_CLIENT_SECRET);
			}
			return vatsim;
		},
		// DB-backed services stay request-scoped so D1 session state never leaks across requests.
		getAuth(env: Env) {
			return new AuthService(env.DB, this.getVatsim(env), this.getPostHog(env));
		},
		getRoles(env: Env) {
			return new RoleService(env.DB);
		},
		getCache(env: Env) {
			if (!cache) {
				cache = new CacheService(env);
			}
			return cache;
		},
		getAirport(env: Env) {
			return new AirportService(env.DB, env.AIRPORTDB_API_KEY, this.getPostHog(env));
		},
		getDivisions(env: Env) {
			return new DivisionService(env.DB, this.getPostHog(env));
		},
		getID() {
			if (!id) {
				id = new IDService();
			}
			return id;
		},
		getPoints(env: Env) {
			return new PointsService(env.DB, this.getID(), this.getDivisions(env), this.getPostHog(env));
		},
		getPolygons(env: Env) {
			return new PolygonService(env.DB, undefined, this.getPostHog(env));
		},
		getSupport(env: Env) {
			return new SupportService(env.DB);
		},
		getNotam(env: Env) {
			return new NotamService(env.DB);
		},
		getContributions(env: Env) {
			return new ContributionService(
				env.DB,
				this.getRoles(env),
				env.AIRPORTDB_API_KEY,
				env.BARS_STORAGE,
				this.getPostHog(env),
			);
		},
		getStorage(env: Env) {
			if (!storage) {
				storage = new StorageService(env.BARS_STORAGE);
			}
			return storage;
		},
		getGitHub(env: Env) {
			if (!github) {
				github = new GitHubService(env.GITHUB_TOKEN);
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
			return new FAQService(env.DB);
		},
		getReleases(env: Env) {
			return new ReleaseService(env.DB, this.getStorage(env));
		},
		getContact(env: Env) {
			return new ContactService(env.DB);
		},
		getDownloads(env: Env) {
			return new DownloadsService(env.DB);
		},
		getVatSysProfiles(env: Env) {
			if (!vatsysProfiles) {
				vatsysProfiles = new VatSysProfilesService(this.getStorage(env));
			}
			return vatsysProfiles;
		},
		getVatSysProfileGenerator(env: Env) {
			return new VatSysProfileGeneratorService(env.DB);
		},
	};
})();
