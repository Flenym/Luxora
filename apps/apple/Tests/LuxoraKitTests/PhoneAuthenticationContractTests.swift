import Foundation
@testable import LuxoraKit
import XCTest

final class PhoneAuthenticationContractTests: XCTestCase {
    func testBeginPayloadIncludesExactFieldsAndUUIDv4Nonce() {
        let nonce = UUID.clientNonceV4()
        let body = APIPhoneAuthenticationBody.begin(
            countryCode: "7",
            nationalNumber: "9991234567",
            deviceName: "iPhone",
            clientNonce: nonce
        )

        XCTAssertEqual(Set(body.keys), ["countryCode", "nationalNumber", "deviceName", "clientNonce"])
        XCTAssertEqual(body["countryCode"], "7")
        XCTAssertEqual(body["nationalNumber"], "9991234567")
        XCTAssertEqual(body["clientNonce"], nonce.uuidString.lowercased())
        assertUUIDv4(nonce)
    }

    func testVerifyPayloadNeverReplaysPhoneAndUsesFreshUUIDv4Nonce() {
        let nonce = UUID.clientNonceV4()
        let body = APIPhoneAuthenticationBody.verify(
            code: "123456",
            deviceName: "iPhone",
            clientNonce: nonce
        )

        XCTAssertEqual(Set(body.keys), ["code", "deviceName", "clientNonce"])
        XCTAssertNil(body["countryCode"])
        XCTAssertNil(body["nationalNumber"])
        assertUUIDv4(nonce)
    }

    func testRegistrationPayloadIncludesExactFieldsAndUUIDv4Nonce() {
        let nonce = UUID.clientNonceV4()
        let body = APIPhoneAuthenticationBody.registration(
            registrationToken: "registration-01",
            displayName: "Егор Flenym",
            username: "flenym",
            bio: "Разработчик Luxora",
            deviceName: "iPhone",
            clientNonce: nonce
        )

        XCTAssertEqual(
            Set(body.keys),
            ["registrationToken", "displayName", "username", "bio", "deviceName", "clientNonce"]
        )
        XCTAssertEqual(body["registrationToken"], "registration-01")
        XCTAssertEqual(body["displayName"], "Егор Flenym")
        XCTAssertEqual(body["username"], "flenym")
        XCTAssertEqual(body["bio"], "Разработчик Luxora")
        assertUUIDv4(nonce)
    }

    func testUsernameAvailabilityDecodesExactContractAndCapsSuggestions() throws {
        let response = try decoder.decode(
            APIPhoneUsernameAvailability.self,
            from: Data(
                #"{"username":"flenym","available":false,"suggestions":["flenym_1","flenym_app","flenym_ru","flenym_chat","flenym_01"]}"#.utf8
            )
        )
        let availability = PhoneUsernameAvailability(response: response)

        XCTAssertEqual(availability.username, "flenym")
        XCTAssertFalse(availability.isAvailable)
        XCTAssertEqual(availability.suggestions.count, 5)
    }

    func testUsernameCheckPayloadUsesOnlyRegistrationTokenAndUsername() {
        let body = APIPhoneAuthenticationBody.usernameCheck(
            registrationToken: "registration-01",
            username: "flenym"
        )

        XCTAssertEqual(Set(body.keys), ["registrationToken", "username"])
        XCTAssertNil(body["clientNonce"])
    }

    func testChallengeDecodesExactCamelCaseContract() throws {
        let challenge = try decoder.decode(
            APIPhoneCodeChallenge.self,
            from: Data(
                #"{"challengeId":"challenge-01","maskedPhone":"+7 ••• •••-42-18","expiresAt":"2026-08-04T15:00:00Z","retryAfterSeconds":30}"#.utf8
            )
        )

        XCTAssertEqual(challenge.challengeId, "challenge-01")
        XCTAssertEqual(challenge.maskedPhone, "+7 ••• •••-42-18")
        XCTAssertEqual(challenge.retryAfterSeconds, 30)
    }

    func testVerifyAuthenticatedDecodesUserAndTokens() throws {
        let result = try decoder.decode(
            APIPhoneCodeVerificationResult.self,
            from: Data(
                #"{"status":"authenticated","user":{"id":"770ec1e2-2fdc-445c-a145-c83bf86c3b20","username":"internal-handle","displayName":"Егор Flenym","bio":"","avatarUrl":null,"createdAt":"2026-08-04T14:00:00Z","presence":"online","lastSeenAt":null},"tokens":{"accessToken":"access","refreshToken":"refresh","tokenType":"Bearer","expiresIn":900,"sessionId":"1f126398-d9dc-4cd0-8cba-9d02bce5358f"}}"#.utf8
            )
        )

        guard case let .authenticated(response) = result else {
            return XCTFail("Expected authenticated result")
        }
        XCTAssertEqual(response.user.displayName, "Егор Flenym")
        XCTAssertEqual(response.tokens.credentials.accessToken, "access")
    }

    func testVerifyProfileRequiredDecodesRegistrationTokenWithoutPhoneReplay() throws {
        let result = try decoder.decode(
            APIPhoneCodeVerificationResult.self,
            from: Data(
                #"{"status":"profile_required","registrationToken":"registration-01","maskedPhone":"+7 ••• •••-42-18","expiresAt":"2026-08-04T15:00:00Z"}"#.utf8
            )
        )

        guard case let .profileRequired(registration) = result else {
            return XCTFail("Expected profile_required result")
        }
        XCTAssertEqual(registration.registrationToken, "registration-01")
        XCTAssertEqual(registration.maskedPhone, "+7 ••• •••-42-18")
    }

    func testVerifyPasswordRequiredDecodesOnlyShortLivedContinuationGrant() throws {
        let token = "luxpw_\(String(repeating: "a", count: 43))"
        let result = try decoder.decode(
            APIPhoneCodeVerificationResult.self,
            from: Data(
                """
                {"status":"password_required","passwordToken":"\(token)","maskedPhone":"+7 ••• •••-42-18","expiresAt":"2026-08-04T15:00:00Z"}
                """.utf8
            )
        )

        guard case let .passwordRequired(challenge) = result else {
            return XCTFail("Expected password_required result")
        }
        XCTAssertEqual(challenge.passwordToken, token)
        XCTAssertEqual(challenge.maskedPhone, "+7 ••• •••-42-18")
    }

    func testPasswordContinuationPayloadHasExactFieldsAndUUIDv4Nonce() {
        let nonce = UUID.clientNonceV4()
        let token = "luxpw_\(String(repeating: "a", count: 43))"
        let body = APIPhoneAuthenticationBody.password(
            passwordToken: token,
            password: "correct horse battery staple",
            deviceName: "iPhone",
            clientNonce: nonce
        )

        XCTAssertEqual(
            Set(body.keys),
            ["passwordToken", "password", "deviceName", "clientNonce"]
        )
        XCTAssertEqual(body["passwordToken"], token)
        XCTAssertEqual(body["password"], "correct horse battery staple")
        XCTAssertNil(body["code"])
        assertUUIDv4(nonce)
    }

    func testNetworkResponseLossRetriesTheSameIdempotencyCommand() {
        var command = PhoneAuthenticationCommandNonce<String>()
        let original = command.acquire(for: "challenge-01:123456")

        command.fail(retainingCommand: true)

        XCTAssertEqual(command.acquire(for: "challenge-01:123456"), original)
        assertUUIDv4(original)
    }

    func testKeychainSaveFailureRetainsCommittedResponseNonceUntilClientAcceptance() {
        var command = PhoneAuthenticationCommandNonce<String>()
        let committedResponseNonce = command.acquire(for: "registration-01")

        // A token response reached the client, but durable Keychain/bootstrap
        // acceptance failed. Retrying must ask the server to replay it exactly.
        command.settleAfterClientAcceptance(false)
        XCTAssertEqual(command.acquire(for: "registration-01"), committedResponseNonce)

        command.settleAfterClientAcceptance(true)
        XCTAssertNotEqual(command.acquire(for: "registration-01"), committedResponseNonce)
    }

    func testTerminalRejectionAndChangedInputRotateNonce() {
        var command = PhoneAuthenticationCommandNonce<String>()
        let rejected = command.acquire(for: "challenge-01:000000")
        command.fail(retainingCommand: false)
        XCTAssertNotEqual(command.acquire(for: "challenge-01:000000"), rejected)

        let priorInput = command.acquire(for: "challenge-01:111111")
        XCTAssertNotEqual(command.acquire(for: "challenge-01:222222"), priorInput)
    }

    func testInvalidPasswordExactRetryRetainsNonceButChangedPasswordRotatesIt() {
        var command = PhoneAuthenticationCommandNonce<String>()
        let original = command.acquire(for: "token:wrong-one")

        command.fail(retainingCommand: PhoneAuthenticationFailure.invalidPassword.retainsIdempotencyCommand)
        XCTAssertEqual(command.acquire(for: "token:wrong-one"), original)
        XCTAssertNotEqual(command.acquire(for: "token:wrong-two"), original)
    }

    func testCorrectPasswordAfterInvalidAttemptIsANewCommandAndCanSettle() {
        var command = PhoneAuthenticationCommandNonce<String>()
        let rejectedNonce = command.acquire(for: "token:wrong-password")
        command.fail(retainingCommand: PhoneAuthenticationFailure.invalidPassword.retainsIdempotencyCommand)

        let correctedNonce = command.acquire(for: "token:correct-password")
        XCTAssertNotEqual(correctedNonce, rejectedNonce)

        command.settleAfterClientAcceptance(true)
        XCTAssertNotEqual(command.acquire(for: "token:correct-password"), correctedNonce)
    }

    func testServerPhoneFailureDiscriminatorsMapToTruthfulRussianStates() {
        XCTAssertEqual(
            PhoneAuthenticationFailure.classify(
                LuxoraAPIError.server(status: 401, code: "PHONE_AUTH_CODE_INVALID", message: "invalid")
            ),
            .invalidCode
        )
        XCTAssertEqual(
            PhoneAuthenticationFailure.classify(
                LuxoraAPIError.server(
                    status: 401,
                    code: "PHONE_AUTH_ATTEMPTS_EXHAUSTED",
                    message: "locked"
                )
            ),
            .attemptsExhausted
        )
        XCTAssertEqual(
            PhoneAuthenticationFailure.classify(
                LuxoraAPIError.server(
                    status: 401,
                    code: "PHONE_AUTH_CHALLENGE_EXPIRED",
                    message: "expired"
                )
            ),
            .challengeExpired
        )
        XCTAssertEqual(
            PhoneAuthenticationFailure.classify(
                LuxoraAPIError.server(
                    status: 429,
                    code: "PHONE_AUTH_RESEND_COOLDOWN",
                    message: "Retry after 47 seconds"
                )
            ),
            .resendCooldown(seconds: 47)
        )
        XCTAssertEqual(
            PhoneAuthenticationFailure.classify(LuxoraAPIError.transport("connection lost")),
            .networkUnavailable
        )
        XCTAssertEqual(
            PhoneAuthenticationFailure.classify(
                LuxoraAPIError.server(
                    status: 401,
                    code: "PHONE_AUTH_PASSWORD_INVALID",
                    message: "invalid"
                )
            ),
            .invalidPassword
        )
        XCTAssertEqual(
            PhoneAuthenticationFailure.classify(
                LuxoraAPIError.server(
                    status: 401,
                    code: "PHONE_AUTH_PASSWORD_ATTEMPTS_EXHAUSTED",
                    message: "locked"
                )
            ),
            .passwordAttemptsExhausted
        )
        XCTAssertEqual(
            PhoneAuthenticationFailure.classify(
                LuxoraAPIError.server(
                    status: 401,
                    code: "PHONE_AUTH_PASSWORD_TOKEN_INVALID",
                    message: "expired"
                )
            ),
            .passwordTokenExpired
        )
    }

    func testClientDoesNotInventPasswordRequiredWithoutServerContract() {
        let failure = PhoneAuthenticationFailure.classify(
            LuxoraAPIError.server(status: 401, code: "PASSWORD_REQUIRED", message: "unknown")
        )
        guard case .unexpected = failure else {
            return XCTFail("An unsupported password discriminator must not create a fake auth step")
        }
    }

    func testVerifyBindingVerifiedDecodesAdditiveUnionMember() throws {
        let token = "luxbt_\(String(repeating: "b", count: 43))"
        let result = try decoder.decode(
            APIPhoneCodeVerificationResult.self,
            from: Data(
                """
                {"status":"binding_verified","bindingToken":"\(token)","maskedPhone":"+7 ••• •••-42-18","expiresAt":"2026-08-04T15:00:00Z"}
                """.utf8
            )
        )

        guard case let .bindingVerified(grant) = result else {
            return XCTFail("Expected binding_verified result")
        }
        XCTAssertEqual(grant.bindingToken, token)
        XCTAssertEqual(grant.maskedPhone, "+7 ••• •••-42-18")

        let publicGrant = PhoneBindingGrant(response: grant)
        XCTAssertEqual(publicGrant.bindingToken, token)
    }

    func testRecoveryStartedDecodesConfirmationWindowContract() throws {
        let token = "luxrc_\(String(repeating: "c", count: 43))"
        let response = try decoder.decode(
            APIPhoneRecoveryStarted.self,
            from: Data(
                """
                {"recoveryToken":"\(token)","maskedPhone":"+7 ••• •••-42-18","confirmAt":"2026-09-10T12:05:00Z","expiresAt":"2026-09-11T12:05:00Z"}
                """.utf8
            )
        )

        let intent = PhoneRecoveryIntent(response: response)
        XCTAssertEqual(intent.recoveryToken, token)
        XCTAssertEqual(intent.confirmAt, Date(timeIntervalSince1970: 1_760_111_700))
        XCTAssertTrue(intent.expiresAt > intent.confirmAt)
    }

    func testRecoveryBodiesHaveExactFieldsAndUUIDv4Nonce() {
        let startNonce = UUID.clientNonceV4()
        let startBody = APIPhoneAuthenticationBody.recoveryStart(
            passwordToken: "luxpw_token",
            clientNonce: startNonce
        )
        XCTAssertEqual(
            Set(startBody.keys),
            ["passwordToken", "clientNonce"]
        )
        assertUUIDv4(UUID(uuidString: startBody["clientNonce"]!)!)

        let completeNonce = UUID.clientNonceV4()
        let completeBody = APIPhoneAuthenticationBody.recoveryComplete(
            recoveryToken: "luxrc_token",
            newPassword: "replacement secret phrase",
            deviceName: "iPhone",
            clientNonce: completeNonce
        )
        XCTAssertEqual(
            Set(completeBody.keys),
            ["recoveryToken", "password", "deviceName", "clientNonce"]
        )
        XCTAssertEqual(completeBody["password"], "replacement secret phrase")
        assertUUIDv4(UUID(uuidString: completeBody["clientNonce"]!)!)
    }

    func testBindingBodiesHaveExactFieldsAndUUIDv4Nonce() {
        let beginNonce = UUID.clientNonceV4()
        let beginBody = APIPhoneAuthenticationBody.bindingBegin(
            countryCode: "7",
            nationalNumber: "9250001122",
            deviceName: "iPhone",
            clientNonce: beginNonce
        )
        XCTAssertEqual(
            Set(beginBody.keys),
            ["countryCode", "nationalNumber", "deviceName", "clientNonce"]
        )
        assertUUIDv4(UUID(uuidString: beginBody["clientNonce"]!)!)

        let completeNonce = UUID.clientNonceV4()
        let completeBody = APIPhoneAuthenticationBody.bindingComplete(
            bindingToken: "luxbt_token",
            clientNonce: completeNonce
        )
        XCTAssertEqual(
            Set(completeBody.keys),
            ["bindingToken", "clientNonce"]
        )
        assertUUIDv4(UUID(uuidString: completeBody["clientNonce"]!)!)
    }

    func testRecoveryFailuresClassifyServerCodes() {
        XCTAssertEqual(
            PhoneAuthenticationFailure.classify(
                LuxoraAPIError.server(
                    status: 401,
                    code: "PHONE_AUTH_RECOVERY_TOKEN_INVALID",
                    message: "invalid"
                )
            ),
            .recoveryTokenExpired
        )
        XCTAssertEqual(
            PhoneAuthenticationFailure.classify(
                LuxoraAPIError.server(
                    status: 403,
                    code: "PHONE_AUTH_RECOVERY_NOT_CONFIRMABLE",
                    message: "Retry after 42 seconds"
                )
            ),
            .recoveryNotConfirmable(seconds: 42)
        )
        XCTAssertFalse(PhoneAuthenticationFailure.recoveryNotConfirmable(seconds: 5).retainsIdempotencyCommand)
    }

    private var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    private func assertUUIDv4(_ uuid: UUID, file: StaticString = #filePath, line: UInt = #line) {
        let value = Array(uuid.uuidString.lowercased())
        XCTAssertEqual(value[14], "4", file: file, line: line)
        XCTAssertTrue("89ab".contains(value[19]), file: file, line: line)
    }
}
