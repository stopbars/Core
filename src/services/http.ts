export async function cancelResponseBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// Best-effort cleanup for response bodies we intentionally do not read.
	}
}
