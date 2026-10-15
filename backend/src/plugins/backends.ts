import { FastifyPluginAsync } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { LiteLLMService } from '../services/litellm.service.js';
import { BackendRegistry } from '../services/backends/backend-registry.js';
import { createLiteLLMBackend } from '../services/backends/litellm.backend.js';
import { createMaasBackend } from '../services/backends/maas.backend.js';
import { createMaasClients, type MaasClients } from '../services/maas/maas-clients.js';
import { getMaasConfig } from '../services/maas/maas-config.js';

/**
 * Registers `fastify.backends` (BackendRegistry). LiteLLM is always present; MaaS is added
 * only when MAAS_ENABLED=true, so with the flag off nothing about the platform changes.
 * The MaaS clients are also exposed as `fastify.maasClients` (undefined when disabled).
 */
const backendsPlugin: FastifyPluginAsync = async (fastify) => {
  const registry = new BackendRegistry();

  const litellm = fastify.hasDecorator('liteLLMService')
    ? fastify.liteLLMService
    : new LiteLLMService(fastify);
  registry.register(createLiteLLMBackend(fastify, litellm));

  let maasClients: MaasClients | undefined;
  if (getMaasConfig(fastify.config).enabled) {
    maasClients = createMaasClients(fastify);
    registry.register(createMaasBackend(maasClients, fastify));
    fastify.log.info(
      {
        k8sMock: maasClients.k8s.mock,
        maasApiMock: maasClients.maasApi.mock,
        prometheusMock: maasClients.prometheus.mock,
      },
      'MaaS backend enabled',
    );
  }

  fastify.decorate('backends', registry);
  fastify.decorate('maasClients', maasClients);
};

export default fastifyPlugin(backendsPlugin, { name: 'backends' });
