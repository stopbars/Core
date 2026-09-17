import type { AuthService } from './auth';
import type { DatabaseSessionService } from './database-session';

export async function getLinkerAccount(
	request: Request,
	auth: Pick<AuthService, 'getUserByApiKey'>,
	db: Pick<DatabaseSessionService, 'executeLatest'>,
): Promise<Response> {
	const headers = { 'Cache-Control': 'no-store' };
	const match = request.headers.get('Authorization')?.match(/^Bearer (BARS_[A-Za-z0-9]{8,256})$/i);
	if (!match) return Response.json({ error: 'Unauthorized' }, { status: 401, headers });

	// Uses the same API-key and active-ban checks as other authenticated routes.
	const user = await auth.getUserByApiKey(match[1]);
	if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401, headers });

	const result = await db.executeLatest<{ approved: number; division_member: number }>(
		`SELECT
			(SELECT COUNT(*) FROM contributions WHERE user_id = ? AND status = 'approved') AS approved,
			EXISTS(SELECT 1 FROM division_members dm JOIN divisions d ON d.id = dm.division_id WHERE dm.vatsim_id = ?) AS division_member`,
		[user.vatsim_id, user.vatsim_id],
	);
	const eligibility = result.results[0];
	if (!eligibility) throw new Error('Unable to check Linker eligibility');

	return Response.json(
		{
			userId: user.vatsim_id,
			userDisplayName: user.display_name || user.vatsim_id,
			approvedContributions: eligibility.approved,
			isDivisionMember: eligibility.division_member === 1,
		},
		{ headers },
	);
}
