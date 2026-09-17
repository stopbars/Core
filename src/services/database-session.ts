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
	served_by_colo?: string;
	duration?: number;
	rows_read?: number;
	rows_written?: number;
	changes?: number;
	last_row_id?: number;
	changed_db?: boolean;
	size_after?: number;
	timings?: { sql_duration_ms: number };
	total_attempts?: number;
}

export interface DatabaseResult<T = unknown> {
	results: T[];
	success: boolean;
	meta?: DatabaseMeta;
}

export interface DatabaseResponse<T = unknown> {
	results?: T | null;
	success: boolean;
	meta?: DatabaseMeta;
}

export interface DatabaseWriteResponse<T = unknown> {
	results?: T[] | null;
	success: boolean;
	meta?: DatabaseMeta;
}

export type DatabaseSerializable = null | number | string | boolean | ArrayBuffer;
export type DatabaseBinding = Record<string, DatabaseSerializable>;

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
	 * Create a type-safe prepared statement
	 */
	public prepare<T extends DatabaseBinding>(query: string, bindings: (keyof T)[]): PreparedStatement<T> {
		return new PreparedStatement(this.db.prepare(query), bindings);
	}

	/**
	 * Execute a prepared statement with session awareness
	 * Automatically starts a session if none exists
	 */
	public async execute<T = unknown>(
		query: string,
		params: DatabaseSerializable[] = [],
		options: SessionOptions = {},
	): Promise<DatabaseResponse<T>> {
		if (!this.session) {
			this.startSession(options);
		}

		try {
			const stmt = this.session!.prepare(query);
			let boundStmt = stmt;

			if (params.length > 0) {
				boundStmt = stmt.bind(...params);
			}

			const result = await boundStmt.first<T>();

			// Update bookmark after operation
			this.getBookmark();

			return {
				results: result,
				success: true,
				meta: {},
			};
		} catch (error) {
			console.error('Database execution error:', error);
			throw error;
		}
	}

	/**
	 * Execute a query that returns all results
	 */
	public async executeAll<T = unknown>(
		query: string,
		params: DatabaseSerializable[] = [],
		options: SessionOptions = {},
	): Promise<DatabaseResult<T>> {
		if (!this.session) {
			this.startSession(options);
		}

		try {
			const stmt = this.session!.prepare(query);
			let boundStmt = stmt;

			if (params.length > 0) {
				boundStmt = stmt.bind(...params);
			}

			const result = await boundStmt.all<T>();

			// Update bookmark after operation
			this.getBookmark();

			return {
				results: result.results || [],
				success: true,
				meta: result.meta || {},
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
	public async executeWrite<T = unknown>(query: string, params: DatabaseSerializable[] = []): Promise<DatabaseWriteResponse<T>> {
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

			const result = await boundStmt.run<T>();

			// Update bookmark after write operation
			this.getBookmark();

			return {
				results: result.results || null,
				success: result.success,
				meta: result.meta || {},
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
	public async executeBatch<TBatchRow = unknown>(
		statements: Array<
			| {
					query: string;
					params?: DatabaseSerializable[];
			  }
			| D1PreparedStatement
		>,
	): Promise<DatabaseWriteResponse<TBatchRow>[]> {
		if (statements.length === 0) return [];

		// Force primary mode for batch operations
		if (!this.session) {
			this.startSession({ mode: 'first-primary' });
		}

		try {
			const preparedStatements = statements.map((statement) => {
				if ('query' in statement) {
					const { query, params = [] } = statement;
					const stmt = this.session!.prepare(query);
					return params.length > 0 ? stmt.bind(...params) : stmt;
				}
				return statement;
			});

			// D1 exposes one generic row type for the whole batch. Callers with
			// heterogeneous statements must supply a union or shared optional-field
			// contract and narrow by the known statement index.
			const results = await this.session!.batch<TBatchRow>(preparedStatements);

			// Update bookmark after batch operation
			this.getBookmark();

			return results;
		} catch (error) {
			console.error('Database batch error:', error);
			throw error;
		}
	}

	/**
	 * Execute independent read statements in one D1 round trip. Unlike the
	 * write-oriented executeBatch(), a new session may start on the nearest
	 * unconstrained replica unless a bookmark is supplied.
	 */
	public async executeReadBatch(
		statements: Array<{ query: string; params?: DatabaseSerializable[] }>,
		bookmark?: string,
	): Promise<DatabaseResult<unknown>[]> {
		if (statements.length === 0) return [];
		if (!this.session) {
			this.startSession(bookmark ? { bookmark } : { mode: 'first-unconstrained' });
		}

		try {
			const preparedStatements = statements.map(({ query, params = [] }) => {
				const stmt = this.session!.prepare(query);
				return params.length > 0 ? stmt.bind(...params) : stmt;
			});
			const results = await this.session!.batch(preparedStatements);
			this.getBookmark();
			return results.map((result) => ({
				results: result.results ?? [],
				success: result.success,
				meta: result.meta ?? {},
			}));
		} catch (error) {
			console.error('Database read batch error:', error);
			throw error;
		}
	}

	/**
	 * Execute a read-only query optimized for performance
	 * Uses unconstrained mode for best performance
	 */
	public async executeRead<T = unknown>(
		query: string,
		params: DatabaseSerializable[] = [],
		bookmark?: string,
	): Promise<DatabaseResult<T>> {
		// Use unconstrained mode for reads unless bookmark is provided
		const sessionOptions: SessionOptions = bookmark ? { bookmark } : { mode: 'first-unconstrained' };

		return this.executeAll<T>(query, params, sessionOptions);
	}

	/**
	 * Execute a query that requires the latest data
	 * Uses primary mode to ensure fresh data
	 */
	public async executeLatest<T = unknown>(query: string, params: DatabaseSerializable[] = []): Promise<DatabaseResult<T>> {
		// A prior unconstrained read may already have opened this service's session.
		// Start a fresh primary-anchored session so this method keeps its freshness
		// guarantee regardless of which operation ran first.
		this.startSession({ mode: 'first-primary' });
		return this.executeAll<T>(query, params);
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
	public getSessionInfo() {
		return {
			hasSession: this.session !== null,
			hasBookmark: this.currentBookmark !== null,
			bookmark: this.currentBookmark,
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
	public static async simpleRead<T>(db: D1Database, query: string, params: DatabaseSerializable[] = []): Promise<DatabaseResult<T>> {
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
		params: DatabaseSerializable[] = [],
	): Promise<DatabaseWriteResponse<unknown>> {
		const session = new DatabaseSessionService(db);
		try {
			return await session.executeWrite(query, params);
		} finally {
			session.closeSession();
		}
	}
}

/**
 * Wrapper around D1PreparedStatement with typed named parameters
 */
export class PreparedStatement<T extends DatabaseBinding> {
	private statement: D1PreparedStatement;
	private bindings: (keyof T)[];

	constructor(statement: D1PreparedStatement, bindings: (keyof T)[]) {
		this.statement = statement;
		this.bindings = bindings;
	}

	public bindAll(binds: T): D1PreparedStatement {
		return this.statement.bind(...this.bindings.map((key) => binds[key] ?? null));
	}
}
