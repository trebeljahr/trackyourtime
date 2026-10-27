import { z } from "zod";
const id = z.string().min(1).max(100);
/** Existing account identity metadata only. Never a source of permissions,
 * financial configuration, encrypted facts or trusted directory membership.
 * Names/email/opaque membership ids are not verified recipient identities. */
export const workspaceMemberMetadataSchema = z.object({
  workspaceId: id,
  userId: id,
  members: z.array(z.object({
    userId: id, memberId: id, name: z.string().max(512), email: z.string().max(320),
  }).strict()).max(200),
}).strict().superRefine((value, ctx) => {
  for (const key of ["userId", "memberId"] as const) {
    if (new Set(value.members.map((row) => row[key])).size !== value.members.length) ctx.addIssue({ code: "custom", message: "Member metadata identities must be unique", path: ["members"] });
  }
});
export type WorkspaceMemberMetadata = z.infer<typeof workspaceMemberMetadataSchema>;
