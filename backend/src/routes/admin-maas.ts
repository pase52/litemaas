import { FastifyPluginAsync } from 'fastify';
import { AuthenticatedRequest } from '../types';
import { ApplicationError } from '../utils/errors.js';
import { MaasReconcilerService } from '../services/maas/maas-reconciler.service.js';

const adminMaasRoutes: FastifyPluginAsync = async (fastify) => {
  // Trigger an immediate reconcile pass (policies + subscriptions + orphan cleanup)
  fastify.post('/reconcile', {
    schema: {
      tags: ['Admin MaaS'],
      description:
        'Re-apply MaaSAuthPolicies and MaaSSubscriptions from the database, delete orphaned managed objects and retry pending keys',
      security: [{ bearerAuth: [] }],
    },
    preHandler: [fastify.authenticate, fastify.requirePermission('admin:maas')],
    handler: async (request) => {
      const user = (request as AuthenticatedRequest).user;
      if (!fastify.maasClients) {
        throw ApplicationError.validation(
          'MaaS backend is not enabled',
          'MAAS_ENABLED',
          false,
          'Set MAAS_ENABLED=true to use the MaaS backend',
        );
      }

      const result = await new MaasReconcilerService(fastify).reconcile();

      await fastify.dbUtils.query(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, metadata, success)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          user.userId,
          'MAAS_RECONCILE',
          'MAAS',
          'reconcile',
          JSON.stringify(result),
          // A skipped pass (another replica holds the lock) did nothing: it is not a success
          result.ran && result.errors.length === 0,
        ],
      );

      return { data: result };
    },
  });
};

export default adminMaasRoutes;
