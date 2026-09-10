import Foundation
import Observation

/// Drives the authenticated phone-binding flow for legacy (password) accounts:
/// begin a challenge, verify the OTP through the shared challenge route and
/// complete the binding with the short-lived grant.
@MainActor
@Observable
public final class PhoneBindingStore {
    public enum Phase: Equatable, Sendable {
        case idle
        case challengeSent
        case verified
        case bound
    }

    public private(set) var phase: Phase = .idle
    public private(set) var challenge: PhoneCodeChallenge?
    public private(set) var grant: PhoneBindingGrant?
    public private(set) var completedStatus: PhonePasswordStatus?
    public private(set) var failureMessage: String?

    var remoteBegin: (@Sendable (String, String) async throws -> APIPhoneCodeChallenge)?
    var remoteVerify: (@Sendable (String, String) async throws -> APIPhoneCodeVerificationResult)?
    var remoteComplete: (@Sendable (String) async throws -> APIPhoneBindingCompleted)?

    public init() {}

    public func begin(countryCode: String, nationalNumber: String) async -> Bool {
        guard let remoteBegin else {
            failureMessage = "Привязка номера на сервере не подключена."
            return false
        }
        let normalizedCode = countryCode.filter(\.isNumber)
        let normalizedNumber = nationalNumber.filter(\.isNumber)
        guard (1...3).contains(normalizedCode.count), (4...14).contains(normalizedNumber.count),
              (7...15).contains(normalizedCode.count + normalizedNumber.count)
        else {
            failureMessage = "Проверьте код страны и номер телефона."
            return false
        }

        failureMessage = nil
        do {
            let response = try await remoteBegin(normalizedCode, normalizedNumber)
            challenge = PhoneCodeChallenge(response: response)
            phase = .challengeSent
            return true
        } catch is CancellationError {
            return false
        } catch {
            failureMessage = Self.russianMessage(for: error)
            return false
        }
    }

    public func verify(code: String) async -> Bool {
        guard let challenge else {
            failureMessage = "Сначала запросите код подтверждения."
            return false
        }
        let normalizedCode = code.filter(\.isNumber)
        guard normalizedCode.count == 6 else {
            failureMessage = "Введите шесть цифр из сообщения."
            return false
        }

        failureMessage = nil
        do {
            let response = try await remoteVerify(challenge.challengeID, normalizedCode)
            guard case let .bindingVerified(response) = result else {
                failureMessage = "Сервер ответил неожиданным статусом для привязки."
                return false
            }
            grant = PhoneBindingGrant(response: response)
            phase = .verified
            return true
        } catch is CancellationError {
            return false
        } catch {
            failureMessage = Self.russianMessage(for: error)
            return false
        }
    }

    public func complete() async -> Bool {
        guard let grant else {
            failureMessage = "Привязка не подтверждена. Начните заново."
            return false
        }

        failureMessage = nil
        do {
            let response = try await remoteComplete(grant.bindingToken)
            completedStatus = PhonePasswordStatus(response: response.phonePassword)
            phase = .bound
            return true
        } catch is CancellationError {
            return false
        } catch {
            failureMessage = Self.russianMessage(for: error)
            return false
        }
    }

    public func reset() {
        phase = .idle
        challenge = nil
        grant = nil
        completedStatus = nil
        failureMessage = nil
    }

    private static func russianMessage(for error: Error) -> String {
        guard case let LuxoraAPIError.server(status, _, message) = error else {
            if error is CancellationError { return "" }
            return "Нет связи с сервером. Проверьте сеть и повторите."
        }
        if status == 401 { return "Сеанс истёк или привязка недействительна. Войдите снова." }
        if status == 409 { return "Этот номер нельзя привязать: он уже занят другим аккаунтом." }
        if status == 429 { return "Слишком много попыток. Подождите и повторите." }
        return "Сервер не выполнил привязку (код \(status)). \(message)"
    }
}
