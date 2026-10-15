import { FastifyInstance } from 'fastify';

/**
 * NotificationService - Placeholder for future notification integration
 * All methods are async no-ops ready for external service integration
 *
 * There is NO delivery channel behind these hooks yet (no email, push, webhook or notifications
 * table): every method only writes a debug log line. Callers must therefore not report counts of
 * "notified" users as delivered - say "to notify" instead - and users learn about changes from
 * the UI (status labels, the migration banner), not from a message.
 *
 * Integration points:
 * - SubscriptionService.createSubscription (pending requests)
 * - SubscriptionService.approveSubscriptions (approvals)
 * - SubscriptionService.denySubscriptions (denials)
 * - SubscriptionService.requestReview (review requests)
 * - SubscriptionService.handleModelRestrictionChange (model restrictions)
 * - MaasMigrationService.migrate (LiteLLM -> MaaS migrations)
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
   * Notify users a model they use is migrating to MaaS (old model keeps working until graceUntil).
   * Log-only today (see the class comment): nothing is delivered to the users.
   * TODO: Implement email/push notification
   */
  async notifyUsersModelMigration(
    oldModelId: string,
    newModelId: string,
    affectedUserIds: string[],
    graceUntil: Date,
  ): Promise<void> {
    this.fastify.log.debug(
      { oldModelId, newModelId, userCount: affectedUserIds.length, graceUntil },
      'Notification hook: Model migrating to MaaS (not implemented)',
    );
    // Future: Send bulk email/push to affected users
  }
}
