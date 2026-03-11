import { FastifyInstance } from 'fastify';

/**
 * NotificationService - Placeholder for future notification integration
 * All methods are async no-ops ready for external service integration
 *
 * Integration points:
 * - SubscriptionService.createSubscription (pending requests)
 * - SubscriptionService.approveSubscriptions (approvals)
 * - SubscriptionService.denySubscriptions (denials)
 * - SubscriptionService.requestReview (review requests)
 * - SubscriptionService.handleModelRestrictionChange (model restrictions)
 */
export class NotificationService {
  constructor(private fastify: FastifyInstance) {}

  /**
   * Notify admins of new pending subscription request
   * TODO: Implement email/push notification
   */
  async notifyAdminsNewPendingRequest(
    subscriptionId: string,
    userId: string,
    modelId: string,
  ): Promise<void> {
    this.fastify.log.debug(
      { subscriptionId, userId, modelId },
      'Notification hook: New pending subscription request (not implemented)',
    );
    // Future: Send email/push to admins
  }

  /**
   * Notify user their subscription was approved
   * TODO: Implement email/push notification
   */
  async notifyUserSubscriptionApproved(
    subscriptionId: string,
    userId: string,
    modelId: string,
  ): Promise<void> {
    this.fastify.log.debug(
      { subscriptionId, userId, modelId },
      'Notification hook: Subscription approved (not implemented)',
    );
    // Future: Send email/push to user
  }

  /**
   * Notify user their subscription was denied
   * TODO: Implement email/push notification
   */
  async notifyUserSubscriptionDenied(
    subscriptionId: string,
    userId: string,
    modelId: string,
    reason: string,
  ): Promise<void> {
    this.fastify.log.debug(
      { subscriptionId, userId, modelId, reason },
      'Notification hook: Subscription denied (not implemented)',
    );
    // Future: Send email/push to user with denial reason
  }

  /**
   * Notify admins user requested review of denied subscription
   * TODO: Implement email/push notification
   */
  async notifyAdminsReviewRequested(
    subscriptionId: string,
    userId: string,
    modelId: string,
  ): Promise<void> {
    this.fastify.log.debug(
      { subscriptionId, userId, modelId },
      'Notification hook: Review requested (not implemented)',
    );
    // Future: Send email/push to admins
  }

  /**
   * Notify users their model became restricted
   * TODO: Implement email/push notification
   */
  async notifyUsersModelRestricted(modelId: string, affectedUserIds: string[]): Promise<void> {
    this.fastify.log.debug(
      { modelId, userCount: affectedUserIds.length },
      'Notification hook: Model restricted (not implemented)',
    );
    // Future: Send bulk email/push to affected users
  }

  /**
   * Notify group members that models were added or removed from their group
   * TODO: Implement email/push notification
   */
  async notifyUsersGroupModelsChanged(
    teamId: string,
    teamName: string,
    memberUserIds: string[],
    addedModels: string[],
    removedModels: string[],
  ): Promise<void> {
    this.fastify.log.debug(
      {
        teamId,
        teamName,
        userCount: memberUserIds.length,
        addedModels,
        removedModels,
      },
      'Notification hook: Group model list changed (not implemented)',
    );
    // Future: Send email/push to each member informing them which models
    // were added to or removed from their group
  }

  /**
   * Notify users their API keys were revoked because their group was deleted
   * TODO: Implement email/push notification
   */
  async notifyUsersGroupApiKeysRevoked(
    teamId: string,
    teamName: string,
    affectedUserIds: string[],
    revokedKeyCount: number,
  ): Promise<void> {
    this.fastify.log.debug(
      { teamId, teamName, userCount: affectedUserIds.length, revokedKeyCount },
      'Notification hook: API keys revoked due to group deletion (not implemented)',
    );
    // Future: Send email/push to each affected user informing them their API key
    // was revoked because the group it was associated with has been deleted
  }
}
