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
