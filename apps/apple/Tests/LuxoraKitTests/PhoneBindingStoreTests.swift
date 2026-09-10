import Foundation
import Testing
@testable import LuxoraKit

@MainActor
struct PhoneBindingStoreTests {
    @Test func beginValidatesE164DigitBoundsBeforeCallingServer() async {
        let store = PhoneBindingStore()
        store.remoteBegin = { _, _ in
            throw LuxoraAPIError.transport("must not be called for invalid input")
        }

        let tooShort = await store.begin(countryCode: "7", nationalNumber: "123")
        #expect(!tooShort)
        #expect(store.failureMessage != nil)
        #expect(store.phase == .idle)
    }

    @Test func beginStoresChallengeAndTransitionsToChallengeSent() async {
        let store = PhoneBindingStore()
        store.remoteBegin = { _, _ in
            APIPhoneCodeChallenge(
                challengeId: "challenge-01",
                maskedPhone: "+7 ••• •••-11-22",
                expiresAt: Date(timeIntervalSince1970: 1_800_000_000),
                retryAfterSeconds: 60
            )
        }

        let started = await store.begin(countryCode: "7", nationalNumber: "9250001122")
        #expect(started)
        #expect(store.phase == .challengeSent)
        #expect(store.challenge?.challengeID == "challenge-01")
        #expect(store.challenge?.maskedPhone == "+7 ••• •••-11-22")
    }

    @Test func verifyAcceptsOnlyBindingVerifiedStatus() async throws {
        let store = PhoneBindingStore()
        store.remoteBegin = { _, _ in
            APIPhoneCodeChallenge(
                challengeId: "challenge-02",
                maskedPhone: "+7 ••• •••-33-44",
                expiresAt: Date(timeIntervalSince1970: 1_800_000_000),
                retryAfterSeconds: 60
            )
        }
        #expect(await store.begin(countryCode: "7", nationalNumber: "9250003344"))

        let bindingToken = "luxbt_\(String(repeating: "b", count: 43))"
        let expiredToken = "luxpw_\(String(repeating: "p", count: 43))"
        store.remoteVerify = { _, _ in
            APIPhoneCodeVerificationResult.passwordRequired(
                APIPhonePasswordChallenge(
                    passwordToken: expiredToken,
                    maskedPhone: "+7 ••• •••-33-44",
                    expiresAt: Date(timeIntervalSince1970: 1_800_000_000)
                )
            )
        }

        let rejected = await store.verify(code: "123456")
        #expect(!rejected)
        #expect(store.phase == .challengeSent)

        store.remoteVerify = { challengeID, code in
            #expect(challengeID == "challenge-02")
            #expect(code == "654321")
            return APIPhoneCodeVerificationResult.bindingVerified(
                APIPhoneBindingVerified(
                    bindingToken: bindingToken,
                    maskedPhone: "+7 ••• •••-33-44",
                    expiresAt: Date(timeIntervalSince1970: 1_800_000_000)
                )
            )
        }

        let accepted = await store.verify(code: "654321")
        #expect(accepted)
        #expect(store.phase == .verified)
        #expect(store.grant?.bindingToken == bindingToken)
    }

    @Test func completeCarriesAuthoritativePasswordStatus() async {
        let store = PhoneBindingStore()
        let bindingToken = "luxbt_\(String(repeating: "c", count: 43))"
        store.remoteVerify = { _, _ in
            APIPhoneCodeVerificationResult.bindingVerified(
                APIPhoneBindingVerified(
                    bindingToken: bindingToken,
                    maskedPhone: "+7 ••• •••-55-66",
                    expiresAt: Date(timeIntervalSince1970: 1_800_000_000)
                )
            )
        }
        #expect(await store.verify(code: "111111"))
        #expect(store.phase == .verified)

        store.remoteComplete = { token in
            #expect(token == bindingToken)
            return APIPhoneBindingCompleted(
                phonePassword: APIPhonePasswordStatus(eligible: true, enabled: false)
            )
        }

        let bound = await store.complete()
        #expect(bound)
        #expect(store.phase == .bound)
        #expect(store.completedStatus?.eligible == true)
        #expect(store.completedStatus?.enabled == false)
    }

    @Test func resetClearsTheWholeFlow() async {
        let store = PhoneBindingStore()
        store.remoteVerify = { _, _ in
            APIPhoneCodeVerificationResult.bindingVerified(
                APIPhoneBindingVerified(
                    bindingToken: "luxbt_\(String(repeating: "d", count: 43))",
                    maskedPhone: "+7 ••• •••-77-88",
                    expiresAt: Date(timeIntervalSince1970: 1_800_000_000)
                )
            )
        }
        #expect(await store.verify(code: "222222"))
        store.failureMessage = "saved failure"
        store.reset()

        #expect(store.phase == .idle)
        #expect(store.challenge == nil)
        #expect(store.grant == nil)
        #expect(store.completedStatus == nil)
        #expect(store.failureMessage == nil)
    }
}
