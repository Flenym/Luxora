export interface PhoneVerificationDelivery {
  challengeId: string;
  e164: string;
  code: string;
  expiresAt: string;
}

/** Providers must treat challengeId as their idempotency key. */
export interface PhoneVerificationDeliveryProvider {
  sendVerificationCode(delivery: PhoneVerificationDelivery): Promise<void>;
}

/** Local/Xcode provider: the fixed configured code is entered manually. */
export class DevelopmentPhoneVerificationDeliveryProvider
implements PhoneVerificationDeliveryProvider {
  async sendVerificationCode(_delivery: PhoneVerificationDelivery): Promise<void> {
    // Deliberately no log or response echo: verification codes are credentials.
  }
}
