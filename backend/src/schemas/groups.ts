import { Type, Static } from '@sinclair/typebox';
import { PaginationSchema, createPaginatedResponse } from './common';

// ─── Enums ───────────────────────────────────────────────────────────────────

export const GroupMemberRoleEnum = Type.Union([
  Type.Literal('admin'),
  Type.Literal('member'),
  Type.Literal('viewer'),
]);

export const BudgetDurationEnum = Type.Union([
  Type.Literal('daily'),
  Type.Literal('weekly'),
  Type.Literal('monthly'),
  Type.Literal('yearly'),
]);

// ─── Response Schemas ────────────────────────────────────────────────────────

/** Response schema for a group */
export const GroupSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  alias: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  maxBudget: Type.Optional(Type.Number()),
  currentSpend: Type.Optional(Type.Number()),
  budgetDuration: Type.Optional(Type.String()),
  tpmLimit: Type.Optional(Type.Number()),
  rpmLimit: Type.Optional(Type.Number()),
  allowedModels: Type.Optional(Type.Array(Type.String())),
  memberCount: Type.Integer(),
  isActive: Type.Boolean(),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});

export type Group = Static<typeof GroupSchema>;

/** Response schema for a group member */
export const GroupMemberSchema = Type.Object({
  id: Type.String(),
  userId: Type.String(),
  role: GroupMemberRoleEnum,
  joinedAt: Type.String({ format: 'date-time' }),
  user: Type.Object({
    id: Type.String(),
    username: Type.String(),
    email: Type.String(),
    fullName: Type.Optional(Type.String()),
  }),
});

export type GroupMember = Static<typeof GroupMemberSchema>;

/** Group with members included */
export const GroupWithMembersSchema = Type.Intersect([
  GroupSchema,
  Type.Object({
    members: Type.Array(GroupMemberSchema),
  }),
]);

export type GroupWithMembers = Static<typeof GroupWithMembersSchema>;

// ─── Body Schemas ────────────────────────────────────────────────────────────

/** Body schema for creating a group */
export const CreateGroupSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  alias: Type.Optional(Type.String({ maxLength: 50 })),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  maxBudget: Type.Optional(Type.Number({ minimum: 0 })),
  budgetDuration: Type.Optional(BudgetDurationEnum),
  tpmLimit: Type.Optional(Type.Integer({ minimum: 0 })),
  rpmLimit: Type.Optional(Type.Integer({ minimum: 0 })),
  allowedModels: Type.Optional(Type.Array(Type.String())),
  adminIds: Type.Optional(Type.Array(Type.String())),
});

export type CreateGroup = Static<typeof CreateGroupSchema>;

/** Body schema for updating a group (all fields optional) */
export const UpdateGroupSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  alias: Type.Optional(Type.String({ maxLength: 50 })),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  maxBudget: Type.Optional(Type.Number({ minimum: 0 })),
  budgetDuration: Type.Optional(BudgetDurationEnum),
  tpmLimit: Type.Optional(Type.Integer({ minimum: 0 })),
  rpmLimit: Type.Optional(Type.Integer({ minimum: 0 })),
  allowedModels: Type.Optional(Type.Array(Type.String())),
  isActive: Type.Optional(Type.Boolean()),
});

export type UpdateGroup = Static<typeof UpdateGroupSchema>;

/** Body schema for updating group details (group admin - limited fields) */
export const UpdateGroupDetailsSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  alias: Type.Optional(Type.String({ maxLength: 50 })),
  description: Type.Optional(Type.String({ maxLength: 500 })),
});

export type UpdateGroupDetails = Static<typeof UpdateGroupDetailsSchema>;

/** Body schema for adding a member to a group */
export const AddGroupMemberSchema = Type.Object({
  userId: Type.String(),
  role: Type.Optional(
    Type.Union([Type.Literal('admin'), Type.Literal('member'), Type.Literal('viewer')], {
      default: 'member',
    }),
  ),
});

export type AddGroupMember = Static<typeof AddGroupMemberSchema>;

/** Body schema for updating a member's role */
export const UpdateGroupMemberRoleSchema = Type.Object({
  role: GroupMemberRoleEnum,
});

export type UpdateGroupMemberRole = Static<typeof UpdateGroupMemberRoleSchema>;

// ─── Query Schemas ───────────────────────────────────────────────────────────

/** Query schema for listing groups with search and filter */
export const GroupListQuerySchema = Type.Intersect([
  PaginationSchema,
  Type.Object({
    search: Type.Optional(Type.String()),
    isActive: Type.Optional(Type.Boolean()),
  }),
]);

export type GroupListQuery = Static<typeof GroupListQuerySchema>;

// ─── Param Schemas ───────────────────────────────────────────────────────────

/** Route parameter schema for group ID */
export const GroupIdParamSchema = Type.Object({
  groupId: Type.String({ format: 'uuid' }),
});

export type GroupIdParam = Static<typeof GroupIdParamSchema>;

/** Route parameter schema for group member (group + user) */
export const GroupMemberParamSchema = Type.Object({
  groupId: Type.String({ format: 'uuid' }),
  userId: Type.String({ format: 'uuid' }),
});

export type GroupMemberParam = Static<typeof GroupMemberParamSchema>;

// ─── Paginated Response Schemas ──────────────────────────────────────────────

/** Paginated response schema for group listings */
export const GroupListResponseSchema = createPaginatedResponse(GroupSchema);

/** Group schema with the current user's role included */
export const GroupWithMyRoleSchema = Type.Intersect([
  GroupSchema,
  Type.Object({
    myRole: Type.Optional(GroupMemberRoleEnum),
  }),
]);

export type GroupWithMyRole = Static<typeof GroupWithMyRoleSchema>;

/** Paginated response for user's groups with role info */
export const MyGroupListResponseSchema = createPaginatedResponse(GroupWithMyRoleSchema);

// ─── User Search Schema ──────────────────────────────────────────────────────

/** Query schema for searching users within a group context */
export const GroupUserSearchQuerySchema = Type.Object({
  search: Type.String({ minLength: 2, maxLength: 100 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
});

export type GroupUserSearchQuery = Static<typeof GroupUserSearchQuerySchema>;

/** Response for user search within group context */
export const GroupUserSearchResponseSchema = Type.Object({
  users: Type.Array(
    Type.Object({
      userId: Type.String(),
      username: Type.String(),
      email: Type.String(),
    }),
  ),
  total: Type.Integer(),
});

export type GroupUserSearchResponse = Static<typeof GroupUserSearchResponseSchema>;

// ─── Budget Info Schema ──────────────────────────────────────────────────────

/** Schema for group budget information */
export const GroupBudgetInfoSchema = Type.Object({
  teamId: Type.String(),
  maxBudget: Type.Optional(Type.Number()),
  currentSpend: Type.Number(),
  budgetUtilization: Type.Number(),
  remainingBudget: Type.Optional(Type.Number()),
  budgetDuration: Type.Optional(Type.String()),
  memberCount: Type.Integer(),
  lastUpdatedAt: Type.String({ format: 'date-time' }),
});

export type GroupBudgetInfo = Static<typeof GroupBudgetInfoSchema>;
