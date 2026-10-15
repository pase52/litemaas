import { describe, it, expect } from 'vitest';
import {
  getMigrationGraceUntil,
  getModelBaseUrl,
  getServedModelName,
  isMaasModel,
  isMaasReauthError,
} from '../../utils/modelBackend';

describe('modelBackend utils', () => {
  describe('isMaasModel', () => {
    it('is true only for maas models', () => {
      expect(isMaasModel({ backendType: 'maas' })).toBe(true);
      expect(isMaasModel({ backendType: 'litellm' })).toBe(false);
      expect(isMaasModel({})).toBe(false);
      expect(isMaasModel(undefined)).toBe(false);
    });
  });

  describe('getServedModelName', () => {
    it('returns the id for LiteLLM models', () => {
      expect(getServedModelName({ id: 'gpt-4' })).toBe('gpt-4');
      expect(
        getServedModelName({ id: 'gpt-4', backendType: 'litellm', backendModelName: 'x' }),
      ).toBe('gpt-4');
    });

    it('prefers the backend model name for MaaS models', () => {
      expect(
        getServedModelName({ id: 'ns/llama', backendType: 'maas', backendModelName: 'llama-3' }),
      ).toBe('llama-3');
    });

    it('falls back to the MaaSModelRef name from the id', () => {
      expect(getServedModelName({ id: 'maas-demo/llama-3-2-3b', backendType: 'maas' })).toBe(
        'llama-3-2-3b',
      );
      expect(getServedModelName({ id: 'plain', backendType: 'maas' })).toBe('plain');
    });
  });

  describe('getMigrationGraceUntil', () => {
    it('parses a valid date and ignores invalid ones', () => {
      expect(
        getMigrationGraceUntil({ migrationGraceUntil: '2030-01-01T00:00:00Z' }),
      ).toBeInstanceOf(Date);
      expect(getMigrationGraceUntil({ migrationGraceUntil: 'nope' })).toBeNull();
      expect(getMigrationGraceUntil({})).toBeNull();
      expect(getMigrationGraceUntil(undefined)).toBeNull();
    });
  });

  describe('isMaasReauthError', () => {
    it('detects the code in the standard error response', () => {
      expect(
        isMaasReauthError({
          response: { status: 403, data: { error: { code: 'MAAS_REAUTH_REQUIRED' } } },
        }),
      ).toBe(true);
    });

    it('detects the code in flat responses, enhanced details and rethrown errors', () => {
      expect(
        isMaasReauthError({ response: { status: 401, data: { code: 'MAAS_REAUTH_REQUIRED' } } }),
      ).toBe(true);
      expect(isMaasReauthError({ enhancedDetails: { error: 'MAAS_REAUTH_REQUIRED' } })).toBe(true);
      expect(
        isMaasReauthError(Object.assign(new Error('x'), { code: 'MAAS_REAUTH_REQUIRED' })),
      ).toBe(true);
    });

    it('is false for other errors', () => {
      expect(isMaasReauthError(new Error('boom'))).toBe(false);
      expect(isMaasReauthError({ response: { data: { error: { code: 'MAAS_ERROR' } } } })).toBe(
        false,
      );
      expect(isMaasReauthError(null)).toBe(false);
    });
  });

  describe('getModelBaseUrl', () => {
    it('prefers the MaaS model endpoint over the key base URL', () => {
      expect(
        getModelBaseUrl(
          { backendType: 'maas', maasEndpoint: 'https://gw/ns/model/' },
          'https://gw',
          'https://litellm',
        ),
      ).toBe('https://gw/ns/model');
    });

    it('strips a trailing /v1 so callers can append it', () => {
      expect(
        getModelBaseUrl(
          { backendType: 'maas', maasEndpoint: 'https://gw/ns/model/v1' },
          undefined,
          'x',
        ),
      ).toBe('https://gw/ns/model');
    });

    it('falls back to the key base URL, then the LiteLLM URL', () => {
      expect(getModelBaseUrl({ backendType: 'maas' }, 'https://gw', 'https://litellm')).toBe(
        'https://gw',
      );
      expect(getModelBaseUrl(undefined, undefined, 'https://litellm')).toBe('https://litellm');
    });

    it('ignores maasEndpoint for LiteLLM models', () => {
      expect(
        getModelBaseUrl(
          { backendType: 'litellm', maasEndpoint: 'https://gw/x' },
          undefined,
          'https://litellm',
        ),
      ).toBe('https://litellm');
    });
  });
});
