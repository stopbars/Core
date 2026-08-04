/**
 * Storage service for handling file operations with R2 storage
 */
export class StorageService {
	private readonly MAX_AGE_DEFAULT = 86400 * 30; // 30 days
	private readonly CORS_HEADERS = {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, HEAD, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
	};
	/**
	 * Creates a new storage service instance
	 * @param bucket The R2 storage bucket
	 */
	constructor(private bucket: R2Bucket) {}

	/**
	 * Uploads a file to R2 storage
	 * @param key The object key/path
	 * @param data The file data
	 * @param contentType The content type of the file
	 * @param metadata Optional metadata to store with the file
	 * @returns Information about the uploaded object
	 */
	async uploadFile(
		key: string,
		data: ReadableStream | ArrayBuffer | string,
		contentType: string,
		metadata: Record<string, string> = {},
		options: { onlyIfAbsent?: boolean } = {},
	): Promise<{ key: string; etag: string }> {
		// Normalize key to avoid any issues
		const normalizedKey = this.normalizeKey(key);

		// Add file type to metadata
		const fileMetadata = {
			...metadata,
			fileType: contentType.split('/')[0] || 'application',
		};

		// Upload to R2
		const uploaded = await this.bucket.put(normalizedKey, data, {
			...(options.onlyIfAbsent ? { onlyIf: { etagDoesNotMatch: '*' } } : {}),
			httpMetadata: {
				contentType,
				cacheControl: `public, max-age=${this.MAX_AGE_DEFAULT}`,
			},
			customMetadata: fileMetadata,
		});

		if (!uploaded) {
			if (options.onlyIfAbsent) throw new Error('Storage object already exists');
			throw new Error('Failed to upload file to storage');
		}

		return {
			key: normalizedKey,
			etag: uploaded.etag,
		};
	}

	/**
	 * Gets a file from R2 storage
	 * @param key The object key
	 * @returns The file as a Response or null if not found
	 */
	async getFile(key: string, requestHeaders?: Headers): Promise<Response | null> {
		const normalizedKey = this.normalizeKey(key);

		// Let R2 read only the requested byte range instead of fetching the full
		// object and slicing it inside the Worker.
		const rangeHeaders = requestHeaders?.has('range') ? requestHeaders : undefined;
		const object = await this.bucket.get(normalizedKey, rangeHeaders ? { range: rangeHeaders } : undefined);

		if (!object) {
			return null;
		}

		// Create headers
		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set('etag', object.httpEtag);
		headers.set('Accept-Ranges', 'bytes');

		let status = 200;
		if (object.range) {
			// Miniflare may expose all union members with undefined values, so narrow
			// by value rather than using the `in` operator.
			const suffix = 'suffix' in object.range && typeof object.range.suffix === 'number' ? object.range.suffix : undefined;
			const rangeOffset = 'offset' in object.range && typeof object.range.offset === 'number' ? object.range.offset : 0;
			const offset = suffix === undefined ? rangeOffset : Math.max(0, object.size - suffix);
			const rangeLength = 'length' in object.range && typeof object.range.length === 'number' ? object.range.length : undefined;
			const length = suffix === undefined ? (rangeLength ?? Math.max(0, object.size - offset)) : Math.min(object.size, suffix);
			headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
			headers.set('Content-Length', String(length));
			status = 206;
		}

		// Add CORS headers
		Object.entries(this.CORS_HEADERS).forEach(([key, value]) => {
			headers.set(key, value);
		});

		return new Response(object.body, {
			status,
			headers,
		});
	}

	/**
	 * Lists files in the storage with a prefix
	 * @param prefix Optional prefix to filter objects
	 * @param limit Maximum number of objects to return
	 * @returns List of objects
	 */
	async listFiles(prefix?: string, limit: number = 100): Promise<{ objects: R2Object[] }> {
		const options: R2ListOptions = {
			prefix: prefix ? this.normalizeKey(prefix) : undefined,
			limit,
		};

		const listed = await this.bucket.list(options);

		return {
			objects: listed.objects,
		};
	}

	/**
	 * Returns only metadata (HEAD) for a single object key, or null if not found
	 */
	async headFile(key: string): Promise<R2Object | null> {
		try {
			const obj = await this.bucket.head(this.normalizeKey(key));
			return obj ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * Deletes a file from R2 storage
	 * @param key The object key
	 * @returns True if deleted, false if not found
	 */
	async deleteFile(key: string): Promise<boolean> {
		const normalizedKey = this.normalizeKey(key);

		try {
			await this.bucket.delete(normalizedKey);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Normalizes a key/path to ensure a consistent format
	 * @param key The key to normalize
	 * @returns The normalized key
	 */
	private normalizeKey(key: string): string {
		// Remove any leading slashes
		let normalizedKey = key.startsWith('/') ? key.substring(1) : key;

		// Replace multiple slashes with a single slash
		normalizedKey = normalizedKey.replace(/\/+/g, '/');

		return normalizedKey;
	}
}
