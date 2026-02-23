import { FastifyPluginAsync } from 'fastify';
import { AuthenticatedRequest } from '../types';
import { TeamService } from '../services/team.service';
import { LiteLLMService } from '../services/litellm.service';
import {
  GroupIdParamSchema,
  GroupMemberParamSchema,
  GroupListQuerySchema,
  CreateGroupSchema,
  UpdateGroupSchema,
  AddGroupMemberSchema,
  UpdateGroupMemberRoleSchema,
  GroupWithMembersSchema,
  GroupListResponseSchema,
  GroupBudgetInfoSchema,
} from '../schemas/groups';
import { ErrorResponseSchema } from '../schemas/common';
import { ApplicationError } from '../utils/errors';

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

const adminGroupsRoutes: FastifyPluginAsync = async (fastify) => {
  const liteLLMService = new LiteLLMService(fastify);
  const teamService = new TeamService(fastify, liteLLMService);

  // GET / - List all groups
  fastify.get('/', {
    schema: {
      tags: ['Admin - Groups'],
      summary: 'List all groups',
      description:
        'Retrieve a paginated list of all groups with optional search and filtering',
      security: [{ bearerAuth: [] }],
      querystring: GroupListQuerySchema,
      response: {
        200: GroupListResponseSchema,
        403: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
    preHandler: [fastify.authenticate, fastify.requirePermission('admin:groups:read')],
    handler: async (request, _reply) => {
      try {
        const { search, isActive, page = 1, limit = 20 } = request.query as {
          search?: string;
          isActive?: boolean;
          page?: number;
          limit?: number;
        };

        const result = await teamService.getAllTeams({ search, isActive, page, limit });

        return {
          data: result.data.map((t) => ({
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
        fastify.log.error({ error }, 'Failed to list groups');

        if (error instanceof ApplicationError) {
          throw error;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        throw fastify.createError(500, `Failed to list groups: ${errorMessage}`);
      }
    },
  });

  // POST / - Create group
  fastify.post('/', {
    schema: {
      tags: ['Admin - Groups'],
      summary: 'Create a new group',
      description:
        'Create a new group with optional budget, rate limits, and initial admin members',
      security: [{ bearerAuth: [] }],
      body: CreateGroupSchema,
      response: {
        201: GroupWithMembersSchema,
        400: ErrorResponseSchema,
        403: ErrorResponseSchema,
        409: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
    preHandler: [fastify.authenticate, fastify.requirePermission('admin:groups:write')],
    handler: async (request, reply) => {
      try {
        const currentUser = (request as AuthenticatedRequest).user;
        const body = request.body as {
          name: string;
          alias?: string;
          description?: string;
          maxBudget?: number;
          budgetDuration?: 'daily' | 'weekly' | 'monthly' | 'yearly';
          tpmLimit?: number;
          rpmLimit?: number;
          allowedModels?: string[];
          adminIds?: string[];
        };

        const team = await teamService.createTeam(currentUser.userId, body);

        reply.code(201);
        return mapTeamToGroup(team);
      } catch (error) {
        fastify.log.error({ error }, 'Failed to create group');

        if (error instanceof ApplicationError) {
          throw error;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        throw fastify.createError(500, `Failed to create group: ${errorMessage}`);
      }
    },
  });

  // GET /:groupId - Get group details
  fastify.get('/:groupId', {
    schema: {
      tags: ['Admin - Groups'],
      summary: 'Get group details',
      description:
        'Retrieve detailed information about a specific group including its members',
      security: [{ bearerAuth: [] }],
      params: GroupIdParamSchema,
      response: {
        200: GroupWithMembersSchema,
        403: ErrorResponseSchema,
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
    preHandler: [fastify.authenticate, fastify.requirePermission('admin:groups:read')],
    handler: async (request, _reply) => {
      try {
        const { groupId } = request.params as { groupId: string };

        const team = await teamService.getTeam(groupId);

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

  // PATCH /:groupId - Update group
  fastify.patch('/:groupId', {
    schema: {
      tags: ['Admin - Groups'],
      summary: 'Update group',
      description:
        'Update group settings including name, budget, rate limits, and allowed models',
      security: [{ bearerAuth: [] }],
      params: GroupIdParamSchema,
      body: UpdateGroupSchema,
      response: {
        200: GroupWithMembersSchema,
        400: ErrorResponseSchema,
        403: ErrorResponseSchema,
        404: ErrorResponseSchema,
        409: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
    preHandler: [fastify.authenticate, fastify.requirePermission('admin:groups:write')],
    handler: async (request, _reply) => {
      try {
        const { groupId } = request.params as { groupId: string };
        const currentUser = (request as AuthenticatedRequest).user;
        const body = request.body as {
          name?: string;
          alias?: string;
          description?: string;
          maxBudget?: number;
          budgetDuration?: 'daily' | 'weekly' | 'monthly' | 'yearly';
          tpmLimit?: number;
          rpmLimit?: number;
          allowedModels?: string[];
          isActive?: boolean;
        };

        const team = await teamService.updateTeam(groupId, currentUser.userId, body, true);

        return mapTeamToGroup(team);
      } catch (error) {
        fastify.log.error({ error }, 'Failed to update group');

        if (error instanceof ApplicationError) {
          throw error;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        throw fastify.createError(500, `Failed to update group: ${errorMessage}`);
      }
    },
  });

  // DELETE /:groupId - Delete group
  fastify.delete('/:groupId', {
    schema: {
      tags: ['Admin - Groups'],
      summary: 'Delete group',
      description:
        'Soft-delete a group. The group will be marked as inactive but data is preserved',
      security: [{ bearerAuth: [] }],
      params: GroupIdParamSchema,
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' } } },
        403: ErrorResponseSchema,
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
    preHandler: [fastify.authenticate, fastify.requirePermission('admin:groups:write')],
    handler: async (request, _reply) => {
      try {
        const { groupId } = request.params as { groupId: string };
        const currentUser = (request as AuthenticatedRequest).user;

        await teamService.deleteTeam(groupId, currentUser.userId, true);

        return { success: true };
      } catch (error) {
        fastify.log.error({ error }, 'Failed to delete group');

        if (error instanceof ApplicationError) {
          throw error;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        throw fastify.createError(500, `Failed to delete group: ${errorMessage}`);
      }
    },
  });

  // POST /:groupId/members - Add member to group
  fastify.post('/:groupId/members', {
    schema: {
      tags: ['Admin - Groups'],
      summary: 'Add member to group',
      description:
        'Add a user to a group with the specified role (defaults to member)',
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
    preHandler: [fastify.authenticate, fastify.requirePermission('admin:groups:write')],
    handler: async (request, reply) => {
      try {
        const { groupId } = request.params as { groupId: string };
        const currentUser = (request as AuthenticatedRequest).user;
        const body = request.body as { userId: string; role?: string };

        const member = await teamService.addTeamMember(
          groupId,
          {
            userId: body.userId,
            teamId: groupId,
            role: (body.role as 'admin' | 'member' | 'viewer') || 'member',
          },
          currentUser.userId,
          true,
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

  // PATCH /:groupId/members/:userId - Update member role
  fastify.patch('/:groupId/members/:userId', {
    schema: {
      tags: ['Admin - Groups'],
      summary: 'Update member role',
      description:
        'Update the role of a group member (admin, member, or viewer)',
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
    preHandler: [fastify.authenticate, fastify.requirePermission('admin:groups:write')],
    handler: async (request, _reply) => {
      try {
        const { groupId, userId } = request.params as { groupId: string; userId: string };
        const currentUser = (request as AuthenticatedRequest).user;
        const { role } = request.body as { role: 'admin' | 'member' | 'viewer' };

        const member = await teamService.updateTeamMemberRole(
          groupId,
          userId,
          role,
          currentUser.userId,
          true,
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

  // DELETE /:groupId/members/:userId - Remove member from group
  fastify.delete('/:groupId/members/:userId', {
    schema: {
      tags: ['Admin - Groups'],
      summary: 'Remove member from group',
      description:
        'Remove a user from a group. Cannot remove the last admin',
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
    preHandler: [fastify.authenticate, fastify.requirePermission('admin:groups:write')],
    handler: async (request, _reply) => {
      try {
        const { groupId, userId } = request.params as { groupId: string; userId: string };
        const currentUser = (request as AuthenticatedRequest).user;

        await teamService.removeTeamMember(groupId, userId, currentUser.userId, true);

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

  // GET /:groupId/budget - Get group budget info
  fastify.get('/:groupId/budget', {
    schema: {
      tags: ['Admin - Groups'],
      summary: 'Get group budget information',
      description:
        'Retrieve budget utilization and spend information for a group',
      security: [{ bearerAuth: [] }],
      params: GroupIdParamSchema,
      response: {
        200: GroupBudgetInfoSchema,
        403: ErrorResponseSchema,
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
    preHandler: [fastify.authenticate, fastify.requirePermission('admin:groups:read')],
    handler: async (request, _reply) => {
      try {
        const { groupId } = request.params as { groupId: string };

        // Admin may not be a team member, so bypass the membership check
        // by fetching the team directly without userId filter
        const team = await teamService.getTeam(groupId);

        if (!team) {
          throw fastify.createNotFoundError('Group');
        }

        const currentSpend = team.currentSpend || 0;
        const maxBudget = team.maxBudget;
        const budgetUtilization = maxBudget ? (currentSpend / maxBudget) * 100 : 0;
        const remainingBudget = maxBudget ? maxBudget - currentSpend : undefined;

        return {
          teamId: groupId,
          maxBudget,
          currentSpend,
          budgetUtilization,
          remainingBudget,
          budgetDuration: team.budgetDuration,
          memberCount: team.memberCount,
          lastUpdatedAt: String(team.updatedAt),
        };
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

export default adminGroupsRoutes;
