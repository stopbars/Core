// D1 types are available globally in Cloudflare Workers environment

export interface SessionOptions {
    /**
     * Session mode for D1 read replication
     * - 'first-primary': Start with latest data from primary (use for writes or critical reads)
     * - 'first-unconstrained': Start with any available instance (use for non-critical reads)
     * - bookmark string: Start from a specific bookmark
     */
    mode?: 'first-primary' | 'first-unconstrained' | string;

    /**
     * Optional bookmark from a previous session for sequential consistency
     */
    bookmark?: string;
}

export interface DatabaseMeta {
    served_by_region?: string;
    served_by_primary?: boolean;
    duration?: number;
    changes?: number;
    last_row_id?: number;
    changed_db?: boolean;
    size_after?: number;
}

export interface DatabaseResult<T = any> {
    results: T[];
    success: boolean;
    meta?: DatabaseMeta;
}

export interface DatabaseResponse<T = any> {
    results?: T | null;
    success: boolean;
    meta?: DatabaseMeta;
}

/**
 * Database Session Service for D1 Read Replication
 * 
 * This service wraps D1 database operations with Sessions API to provide:
 * - Sequential consistency across read replicas
 * - Automatic session management with bookmarks
 * - Optimized routing for read vs write operations
 */
export class DatabaseSessionService {
    private session: D1DatabaseSession | null = null;
    private currentBookmark: string | null = null;
    private readonly db: D1Database;

    constructor(db: D1Database) {
        this.db = db;
    }

    /**
     * Start a new database session with optional configuration
     */
    public startSession(options: SessionOptions = {}): void {
        let sessionParam: string | undefined;

        if (options.bookmark) {
            // Use provided bookmark for sequential consistency
            sessionParam = options.bookmark;
        } else if (options.mode === 'first-primary') {
            // Start with latest data from primary
            sessionParam = 'first-primary';
        } else {
            // Default to unconstrained for better performance
            sessionParam = 'first-unconstrained';
        }

        this.session = this.db.withSession(sessionParam);
        this.currentBookmark = null;
    }

    /**
     * Get the current session bookmark for maintaining consistency
     */
    public getBookmark(): string | null {
        if (!this.session) {
            return null;
        }

        const bookmark = this.session.getBookmark();
        if (bookmark) {
            this.currentBookmark = bookmark;
        }
        return bookmark;
    }

    /**
     * Execute a prepared statement with session awareness
     * Automatically starts a session if none exists
     */
    public async execute<T = any>(
        query: string,
        params: any[] = [],
        options: SessionOptions = {}
    ): Promise<DatabaseResponse<T>> {
        // Start session if not already started
        if (!this.session) {
            this.startSession(options);
        }

        try {
            const stmt = this.session!.prepare(query);
            let boundStmt = stmt;

            // Bind parameters if provided
            if (params.length > 0) {
                boundStmt = stmt.bind(...params);
            }

            const result = await boundStmt.first<T>();

            // Update bookmark after operation
            this.getBookmark();

            return {
                results: result,
                success: true,
                meta: {}
            };
        } catch (error) {
            console.error('Database execution error:', error);
            throw error;
        }
    }

    /**
     * Execute a query that returns all results
     */
    public async executeAll<T = any>(
        query: string,
        params: any[] = [],
        options: SessionOptions = {}
    ): Promise<DatabaseResult<T>> {
        // Start session if not already started
        if (!this.session) {
            this.startSession(options);
        }

        try {
            const stmt = this.session!.prepare(query);
            let boundStmt = stmt;

            // Bind parameters if provided
            if (params.length > 0) {
                boundStmt = stmt.bind(...params);
            }

            const result = await boundStmt.all<T>();

            // Update bookmark after operation
            this.getBookmark();

            return {
                results: result.results || [],
                success: true,
                meta: result.meta || {}
            };
        } catch (error) {
            console.error('Database executeAll error:', error);
            throw error;
        }
    }

    /**
     * Execute a query that modifies data (INSERT, UPDATE, DELETE)
     * Always uses primary database for consistency
     */
    public async executeWrite(
        query: string,
        params: any[] = []
    ): Promise<DatabaseResponse<any>> {
        // Force primary mode for write operations
        if (!this.session) {
            this.startSession({ mode: 'first-primary' });
        }

        try {
            const stmt = this.session!.prepare(query);
            let boundStmt = stmt;

            // Bind parameters if provided
            if (params.length > 0) {
                boundStmt = stmt.bind(...params);
            }

            const result = await boundStmt.run();

            // Update bookmark after write operation
            this.getBookmark();

            return {
                results: result.results || null,
                success: result.success,
                meta: result.meta || {}
            };
        } catch (error) {
            console.error('Database write error:', error);
            throw error;
        }
    }

    /**
     * Execute multiple statements in a batch
     * Uses primary database for consistency
     */
    public async executeBatch(statements: Array<{
        query: string;
        params?: any[];
    }>): Promise<DatabaseResponse<any>[]> {
        // Force primary mode for batch operations
        if (!this.session) {
            this.startSession({ mode: 'first-primary' });
        }

        try {
            const preparedStatements = statements.map(({ query, params = [] }) => {
                const stmt = this.session!.prepare(query);
                return params.length > 0 ? stmt.bind(...params) : stmt;
            });

            const results = await this.session!.batch(preparedStatements);

            // Update bookmark after batch operation
            this.getBookmark();

            return results.map((result: any) => ({
                success: result.success,
                meta: result.meta || {}
            }));
        } catch (error) {
            console.error('Database batch error:', error);
            throw error;
        }
    }

    /**
     * Execute a read-only query optimized for performance
     * Uses unconstrained mode for best performance
     */
    public async executeRead<T = any>(
        query: string,
        params: any[] = [],
        bookmark?: string
    ): Promise<DatabaseResult<T>> {
        // Use unconstrained mode for reads unless bookmark is provided
        const sessionOptions: SessionOptions = bookmark
            ? { bookmark }
            : { mode: 'first-unconstrained' };

        return this.executeAll<T>(query, params, sessionOptions);
    }

    /**
     * Execute a query that requires the latest data
     * Uses primary mode to ensure fresh data
     */
    public async executeLatest<T = any>(
        query: string,
        params: any[] = []
    ): Promise<DatabaseResult<T>> {
        return this.executeAll<T>(query, params, { mode: 'first-primary' });
    }

    /**
     * Close the current session and clean up resources
     */
    public closeSession(): void {
        this.session = null;
        this.currentBookmark = null;
    }

    /**
     * Get current session statistics for observability
     */
    public getSessionInfo(): {
        hasSession: boolean;
        hasBookmark: boolean;
        bookmark: string | null;
    } {
        return {
            hasSession: this.session !== null,
            hasBookmark: this.currentBookmark !== null,
            bookmark: this.currentBookmark
        };
    }

    /**
     * Static helper to create a session-aware database service
     */
    public static create(db: D1Database): DatabaseSessionService {
        return new DatabaseSessionService(db);
    }

    /**
     * Static helper for simple read operations
     */
    public static async simpleRead<T>(
        db: D1Database,
        query: string,
        params: any[] = []
    ): Promise<DatabaseResult<T>> {
        const session = new DatabaseSessionService(db);
        try {
            return await session.executeRead<T>(query, params);
        } finally {
            session.closeSession();
        }
    }

    /**
     * Static helper for simple write operations
     */
    public static async simpleWrite(
        db: D1Database,
        query: string,
        params: any[] = []
    ): Promise<DatabaseResponse<any>> {
        const session = new DatabaseSessionService(db);
        try {
            return await session.executeWrite(query, params);
        } finally {
            session.closeSession();
        }
    }
}
