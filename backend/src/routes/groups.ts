import { FastifyPluginAsync } from 'fastify';
import { AuthenticatedRequest } from '../types';
import { TeamService } from '../services/team.service';
import { LiteLLMService } from '../services/litellm.service';
import {
  GroupIdParamSchema,
  GroupMemberParamSchema,
  GroupListQuerySchema,
  AddGroupMemberSchema,
  UpdateGroupMemberRoleSchema,
  GroupWithMembersSchema,
  GroupListResponseSchema,
  GroupBudgetInfoSchema,
} from '../schemas/groups';
import { ErrorResponseSchema } from '../schemas/common';
import { ApplicationError } from '../utils/errors';

const DEFAULT_TEAM_ID = 'a0000000-0000-4000-8000-000000000001';

/**
 * Maps a TeamWithMembers object from the service layer to the group response shape
 * expected by the API schema.
 */
function mapTeamToGroup(team: any) {
  return {
    id: team.id,
    name: team.name,
    alias: team.alias,
    description: team.description,
    maxBudget: team.maxBudget,
    currentSpend: team.currentSpend,
    budgetDuration: team.budgetDuration,
    tpmLimit: team.tpmLimit,
    rpmLimit: team.rpmLimit,
    allowedModels: team.allowedModels,
    memberCount: team.memberCount,
    isActive: team.isActive,
    createdAt: String(team.createdAt),
    updatedAt: String(team.updatedAt),
    members: (team.members || []).map((m: any) => ({
      id: m.id,
      userId: m.userId,
      role: m.role,
      joinedAt: String(m.joinedAt),
      user: {
        id: m.user.id,
        username: m.user.username,
        email: m.user.email,
        fullName: m.user.fullName,
      },
    })),
  };
}

const groupsRoutes: FastifyPluginAsync = async (fastify) => {
  const liteLLMService = new LiteLLMService(fastify);
  const teamService = new TeamService(fastify, liteLLMService);

  // GET / - List my groups
  fastify.get('/', {
    schema: {
      tags: ['Groups'],
      summary: 'List my groups',
      description:
        'Retrieve a paginated list of groups that the current user belongs to',
      security: [{ bearerAuth: [] }],
      querystring: GroupListQuerySchema,
      response: {
        200: GroupListResponseSchema,
        403: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
    preHandler: [fastify.authenticate],
    handler: async (request, _reply) => {
      try {
        const currentUser = (request as AuthenticatedRequest).user;
        const { search, isActive, page = 1, limit = 20 } = request.query as {
          search?: string;
          isActive?: boolean;
          page?: number;
          limit?: number;
        };

        const result = await teamService.getUserTeams(currentUser.userId, {
          search,
          isActive,
          page,
          limit,
        });

        // Filter out the default team from results
        const filtered = result.data.filter((t) => t.id !== DEFAULT_TEAM_ID);

        return {
          data: filtered.map((t) => ({
            id: t.id,
            name: t.name,
            alias: t.alias,
            description: t.description,
            maxBudget: t.maxBudget,
            currentSpend: t.currentSpend,
            budgetDuration: t.budgetDuration,
            tpmLimit: t.tpmLimit,
            rpmLimit: t.rpmLimit,
            allowedModels: t.allowedModels,
            memberCount: t.memberCount,
            isActive: t.isActive,
            createdAt: String(t.createdAt),
            updatedAt: String(t.updatedAt),
          })),
          pagination: {
            page,
            limit,
            total: result.total,
            totalPages: Math.ceil(result.total / limit),
          },
        };
      } catch (error) {
        fastify.log.error({ error }, 'Failed to list user groups');

        if (error instanceof ApplicationError) {
          throw error;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        throw fastify.createError(500, `Failed to list user groups: ${errorMessage}`);
      }
    },
  });

  // GET /:groupId - Get group details (membership enforced by service)
  fastify.get('/:groupId', {
    schema: {
      tags: ['Groups'],
      summary: 'Get group details',
      description:
        'Retrieve detailed information about a specific group including its members. User must be a member of the group.',
      security: [{ bearerAuth: [] }],
      params: GroupIdParamSchema,
      response: {
        200: GroupWithMembersSchema,
        403: ErrorResponseSchema,
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
    preHandler: [fastify.authenticate],
    handler: async (request, _reply) => {
      try {
        const currentUser = (request as AuthenticatedRequest).user;
        const { groupId } = request.params as { groupId: string };

        const team = await teamService.getTeam(groupId, currentUser.userId);

        if (!team) {
          throw fastify.createNotFoundError('Group');
        }

        return mapTeamToGroup(team);
      } catch (error) {
        fastify.log.error({ error }, 'Failed to get group details');

        if (error instanceof ApplicationError) {
          throw error;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        throw fastify.createError(500, `Failed to get group details: ${errorMessage}`);
      }
    },
  });

  // POST /:groupId/members - Invite member (team admin check done in service)
  fastify.post('/:groupId/members', {
    schema: {
      tags: ['Groups'],
      summary: 'Add member to group',
      description:
        'Add a user to a group with the specified role. The current user must be a team admin.',
      security: [{ bearerAuth: [] }],
      params: GroupIdParamSchema,
      body: AddGroupMemberSchema,
      response: {
        201: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            userId: { type: 'string' },
            role: { type: 'string' },
            joinedAt: { type: 'string', format: 'date-time' },
            user: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                username: { type: 'string' },
                email: { type: 'string' },
                fullName: { type: 'string' },
              },
            },
          },
        },
        400: ErrorResponseSchema,
        403: ErrorResponseSchema,
        404: ErrorResponseSchema,
        409: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const currentUser = (request as AuthenticatedRequest).user;
        const { groupId } = request.params as { groupId: string };
        const body = request.body as { userId: string; role?: string };

        const member = await teamService.addTeamMember(
          groupId,
          {
            userId: body.userId,
            teamId: groupId,
            role: (body.role as 'admin' | 'member' | 'viewer') || 'member',
          },
          currentUser.userId,
        );

        reply.code(201);
        return {
          id: member.id,
          userId: member.userId,
          role: member.role,
          joinedAt: String(member.joinedAt),
          user: {
            id: member.user.id,
            username: member.user.username,
            email: member.user.email,
            fullName: member.user.fullName,
          },
        };
      } catch (error) {
        fastify.log.error({ error }, 'Failed to add group member');

        if (error instanceof ApplicationError) {
          throw error;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        throw fastify.createError(500, `Failed to add group member: ${errorMessage}`);
      }
    },
  });

  // PATCH /:groupId/members/:userId - Update member role (team admin check in service)
  fastify.patch('/:groupId/members/:userId', {
    schema: {
      tags: ['Groups'],
      summary: 'Update member role',
      description:
        'Update the role of a group member. The current user must be a team admin.',
      security: [{ bearerAuth: [] }],
      params: GroupMemberParamSchema,
      body: UpdateGroupMemberRoleSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            userId: { type: 'string' },
            role: { type: 'string' },
            joinedAt: { type: 'string', format: 'date-time' },
            user: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                username: { type: 'string' },
                email: { type: 'string' },
                fullName: { type: 'string' },
              },
            },
          },
        },
        400: ErrorResponseSchema,
        403: ErrorResponseSchema,
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
    preHandler: [fastify.authenticate],
    handler: async (request, _reply) => {
      try {
        const currentUser = (request as AuthenticatedRequest).user;
        const { groupId, userId } = request.params as { groupId: string; userId: string };
        const { role } = request.body as { role: 'admin' | 'member' | 'viewer' };

        const member = await teamService.updateTeamMemberRole(
          groupId,
          userId,
          role,
          currentUser.userId,
        );

        return {
          id: member.id,
          userId: member.userId,
          role: member.role,
          joinedAt: String(member.joinedAt),
          user: {
            id: member.user.id,
            username: member.user.username,
            email: member.user.email,
            fullName: member.user.fullName,
          },
        };
      } catch (error) {
        fastify.log.error({ error }, 'Failed to update group member role');

        if (error instanceof ApplicationError) {
          throw error;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        throw fastify.createError(500, `Failed to update group member role: ${errorMessage}`);
      }
    },
  });

  // DELETE /:groupId/members/:userId - Remove member (team admin check in service)
  fastify.delete('/:groupId/members/:userId', {
    schema: {
      tags: ['Groups'],
      summary: 'Remove member from group',
      description:
        'Remove a user from a group. The current user must be a team admin. Cannot remove the last admin.',
      security: [{ bearerAuth: [] }],
      params: GroupMemberParamSchema,
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' } } },
        400: ErrorResponseSchema,
        403: ErrorResponseSchema,
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
    preHandler: [fastify.authenticate],
    handler: async (request, _reply) => {
      try {
        const currentUser = (request as AuthenticatedRequest).user;
        const { groupId, userId } = request.params as { groupId: string; userId: string };

        await teamService.removeTeamMember(groupId, userId, currentUser.userId);

        return { success: true };
      } catch (error) {
        fastify.log.error({ error }, 'Failed to remove group member');

        if (error instanceof ApplicationError) {
          throw error;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        throw fastify.createError(500, `Failed to remove group member: ${errorMessage}`);
      }
    },
  });

  // GET /:groupId/budget - View group budget (member check in service)
  fastify.get('/:groupId/budget', {
    schema: {
      tags: ['Groups'],
      summary: 'Get group budget information',
      description:
        'Retrieve budget utilization and spend information for a group. User must be a member of the group.',
      security: [{ bearerAuth: [] }],
      params: GroupIdParamSchema,
      response: {
        200: GroupBudgetInfoSchema,
        403: ErrorResponseSchema,
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
    preHandler: [fastify.authenticate],
    handler: async (request, _reply) => {
      try {
        const currentUser = (request as AuthenticatedRequest).user;
        const { groupId } = request.params as { groupId: string };

        const budgetInfo = await teamService.getTeamBudgetInfo(groupId, currentUser.userId);

        return budgetInfo;
      } catch (error) {
        fastify.log.error({ error }, 'Failed to get group budget info');

        if (error instanceof ApplicationError) {
          throw error;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        throw fastify.createError(500, `Failed to get group budget info: ${errorMessage}`);
      }
    },
  });
};

export default groupsRoutes;
