// services/ServicePool.ts
import { VatsimService } from './vatsim';
import { StatsService } from './stats';
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

export const ServicePool = (() => {
    let vatsim: VatsimService;
    let stats: StatsService;
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

    return {
        getVatsim(env: Env) {
            if (!vatsim) {
                vatsim = new VatsimService(env.VATSIM_CLIENT_ID, env.VATSIM_CLIENT_SECRET);
            }
            return vatsim;
        },
        getStats(env: Env) {
            if (!stats) {
                stats = new StatsService(env.DB);
            }
            return stats;
        },
        getAuth(env: Env) {
            if (!auth) {
                auth = new AuthService(env.DB, this.getVatsim(env), this.getStats(env));
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
                airport = new AirportService(env.DB, env.AIRPORTDB_API_KEY);
            }
            return airport;
        },
        getDivisions(env: Env) {
            if (!divisions) {
                divisions = new DivisionService(env.DB);
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
                points = new PointsService(env.DB, this.getID(env), this.getDivisions(env), this.getAuth(env));
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
                contributions = new ContributionService(env.DB, this.getRoles(env), env.AIRPORTDB_API_KEY, env.BARS_STORAGE);
            }
            return contributions;
        },
        getStorage(env: Env) {
            if (!storage) {
                storage = new StorageService(env.BARS_STORAGE);
            }
            return storage;
        }
    };
})();
