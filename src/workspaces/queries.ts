import { asc, desc, eq } from 'drizzle-orm';
import { database } from '../db/client';
import { workspace, workspaceMember } from '../db/schema';

export type UserWorkspace = {
  id: string;
  name: string;
  createdAt: Date;
  role: 'OWNER' | 'MEMBER';
};

export async function listUserWorkspaces(userId: string): Promise<UserWorkspace[]> {
  return database
    .select({
      id: workspace.id,
      name: workspace.name,
      createdAt: workspace.createdAt,
      role: workspaceMember.role,
    })
    .from(workspaceMember)
    .innerJoin(workspace, eq(workspaceMember.workspaceId, workspace.id))
    .where(eq(workspaceMember.userId, userId))
    .orderBy(desc(workspace.createdAt), asc(workspace.id));
}
