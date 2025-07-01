import { DatabaseSessionService, SessionOptions } from './database-session';

/**
 * Bookmark management for HTTP requests
 * Handles extracting bookmarks from request headers and setting response headers
 */
export class BookmarkManager {
    private static readonly BOOKMARK_HEADER = 'x-d1-bookmark';

    /**
     * Extract bookmark from request headers
     */
    public static getBookmarkFromRequest(request: Request): string | undefined {
        return request.headers.get(BookmarkManager.BOOKMARK_HEADER) || undefined;
    }

    /**
     * Set bookmark in response headers
     */
    public static setBookmarkInResponse(response: Response, bookmark: string | null): void {
        if (bookmark) {
            response.headers.set(BookmarkManager.BOOKMARK_HEADER, bookmark);
        }
    }

    /**
     * Create a new Response with bookmark header set
     */
    public static responseWithBookmark(
        body: any,
        bookmark: string | null,
        init: ResponseInit = {}
    ): Response {
        const headers = new Headers(init.headers);
        if (bookmark) {
            headers.set(BookmarkManager.BOOKMARK_HEADER, bookmark);
        }

        return new Response(
            typeof body === 'string' ? body : JSON.stringify(body),
            {
                ...init,
                headers
            }
        );
    }
}

/**
 * Session-aware database context for HTTP request handling
 * Automatically manages sessions and bookmarks for the request lifecycle
 */
export class RequestDatabaseContext {
    private sessionService: DatabaseSessionService;
    private request: Request;
    private isStarted: boolean = false;

    constructor(db: D1Database, request: Request) {
        this.sessionService = new DatabaseSessionService(db);
        this.request = request;
    }

    /**
     * Start a session using bookmark from request headers or specified options
     */
    public startSession(options: Omit<SessionOptions, 'bookmark'> = {}): void {
        if (this.isStarted) {
            return; // Already started
        }

        const bookmark = BookmarkManager.getBookmarkFromRequest(this.request);
        const sessionOptions: SessionOptions = {
            ...options,
            bookmark: bookmark || options.mode || 'first-unconstrained'
        };

        this.sessionService.startSession(sessionOptions);
        this.isStarted = true;
    }

    /**
     * Get the database session service
     */
    public get db(): DatabaseSessionService {
        if (!this.isStarted) {
            this.startSession();
        }
        return this.sessionService;
    }

    /**
     * Create a JSON response with bookmark header
     */
    public jsonResponse(data: any, init: ResponseInit = {}): Response {
        const bookmark = this.sessionService.getBookmark();

        const headers = new Headers(init.headers);
        headers.set('Content-Type', 'application/json');

        return BookmarkManager.responseWithBookmark(
            JSON.stringify(data),
            bookmark,
            { ...init, headers }
        );
    }

    /**
     * Create a text response with bookmark header
     */
    public textResponse(text: string, init: ResponseInit = {}): Response {
        const bookmark = this.sessionService.getBookmark();
        return BookmarkManager.responseWithBookmark(text, bookmark, init);
    }

    /**
     * Close the session and clean up
     */
    public close(): void {
        this.sessionService.closeSession();
        this.isStarted = false;
    }

    /**
     * Get current session info for debugging
     */
    public getSessionInfo() {
        return {
            ...this.sessionService.getSessionInfo(),
            isStarted: this.isStarted,
            requestBookmark: BookmarkManager.getBookmarkFromRequest(this.request)
        };
    }
}

/**
 * Factory for creating database contexts
 */
export class DatabaseContextFactory {
    /**
     * Create a new request database context
     */
    public static createRequestContext(db: D1Database, request: Request): RequestDatabaseContext {
        return new RequestDatabaseContext(db, request);
    }

    /**
     * Create a simple session service for background operations
     */
    public static createSessionService(db: D1Database): DatabaseSessionService {
        return new DatabaseSessionService(db);
    }

    /**
     * Quick read operation for simple queries
     */
    public static async quickRead<T>(
        db: D1Database,
        query: string,
        params: any[] = []
    ) {
        return DatabaseSessionService.simpleRead<T>(db, query, params);
    }

    /**
     * Quick write operation for simple queries
     */
    public static async quickWrite(
        db: D1Database,
        query: string,
        params: any[] = []
    ) {
        return DatabaseSessionService.simpleWrite(db, query, params);
    }
}
