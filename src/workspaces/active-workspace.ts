import type { UserWorkspace } from './queries';

export type ActiveWorkspaceResolution =
  { status: 'selected'; workspace: UserWorkspace } | { status: 'empty' } | { status: 'not-member' };

/**
 * Resolves a client-selected workspace only against memberships loaded for the
 * authenticated user. A requested ID is never treated as proof of access.
 */
export function resolveActiveWorkspace(
  memberships: readonly UserWorkspace[],
  requestedWorkspaceId: string | undefined,
): ActiveWorkspaceResolution {
  if (requestedWorkspaceId === undefined) {
    const firstMembership = memberships[0];
    return firstMembership
      ? { status: 'selected', workspace: firstMembership }
      : { status: 'empty' };
  }

  const membership = memberships.find((workspace) => workspace.id === requestedWorkspaceId);
  return membership ? { status: 'selected', workspace: membership } : { status: 'not-member' };
}
