import Foundation
import Testing
@testable import LuxoraKit

struct ServerCapabilitiesTests {
    @Test
    func currentContractMapsOnlyAdvertisedFeatures() throws {
        let capabilities = try decodeCapabilities().validated()
        let matrix = LuxoraFeatureMatrix(capabilityState: .available(capabilities))

        #expect(capabilities.features.phoneAuthentication)
        #expect(capabilities.features.chatFolders)
        #expect(!capabilities.features.drafts)
        #expect(capabilities.limits.maxDraftCodePoints == nil)
        #expect(capabilities.limits.maxChatFolders == 10)
        #expect(capabilities.limits.maxChatFolderTitleLength == 48)
        #expect(capabilities.limits.maxChatFolderOverrides == 100)
        #expect(capabilities.limits.chatFolderIdempotencyTTLSeconds == 86_400)
        #expect(capabilities.limits.maxChatFolderActiveCommandReceipts == 64)
        #expect(capabilities.realtimeProtocolVersion == .legacyV1)
        #expect(matrix.chats.state == .available)
        #expect(matrix.mediaFiles.state == .limited)
        #expect(matrix.realtime.state == .limited)
        #expect(matrix.calls.state == .unavailable)
        #expect(matrix.pushJobs.state == .unavailable)
        #expect(matrix.securityE2EE.state == .unavailable)
        #expect(matrix.communities.state == .limited)
        #expect(matrix.stories.state == .unavailable)
        #expect(matrix.allSections.count == 12)
    }

    @Test
    func additiveDraftCapabilityNegotiatesCurrentLimitAndLegacyOmissionOff() throws {
        let legacy = try decodeCapabilities().validated()
        #expect(!legacy.features.drafts)
        #expect(legacy.limits.maxDraftCodePoints == nil)

        let payload = capabilityJSON
            .replacingOccurrences(
                of: #""phoneAuthentication":true"#,
                with: #""drafts":true,"phoneAuthentication":true"#
            )
            .replacingOccurrences(
                of: #""maxMessageCodePoints":10000"#,
                with: #""maxDraftCodePoints":10000,"maxMessageCodePoints":10000"#
            )
            .replacingOccurrences(
                of: #""supported":[1],"preferred":1,"minimum":1"#,
                with: #""supported":[1,2],"preferred":2,"minimum":1"#
            )
            .replacingOccurrences(
                of: #""reconciliation":[1]"#,
                with: #""reconciliation":[2]"#
            )
        let current = try JSONDecoder().decode(APICapabilities.self, from: Data(payload.utf8))
        let validated = try current.validated()
        #expect(validated.features.drafts)
        #expect(validated.limits.maxDraftCodePoints == 10_000)
        #expect(validated.supportsSynchronizedDrafts)
    }

    @Test
    func legacyRealtimeCannotAdvertiseSynchronizedDrafts() throws {
        let payload = capabilityJSON
            .replacingOccurrences(
                of: #""phoneAuthentication":true"#,
                with: #""drafts":true,"phoneAuthentication":true"#
            )
            .replacingOccurrences(
                of: #""maxMessageCodePoints":10000"#,
                with: #""maxDraftCodePoints":10000,"maxMessageCodePoints":10000"#
            )
        let decoded = try JSONDecoder().decode(APICapabilities.self, from: Data(payload.utf8))
        #expect(throws: LuxoraAPIError.self) { try decoded.validated() }

        let forgedLegacy = ServerCapabilities(
            trust: .init(
                profile: "cloud_preview",
                contentReadableByServer: true,
                endToEndEncryption: false
            ),
            features: .init(
                phoneAuthentication: true,
                passwordAuthentication: true,
                deviceSessions: true,
                messaging: true,
                identityAccess: true,
                safetyReports: true,
                realtime: true,
                reconciliation: true,
                mediaUploads: true,
                serverSearchConfigured: false,
                calls: false,
                passkeys: false,
                push: false,
                drafts: true
            ),
            limits: .init(
                maxMessageCodePoints: 10_000,
                maxAttachmentsPerMessage: 10,
                maxAttachmentBytes: 104_857_600,
                maxDraftCodePoints: 10_000
            ),
            realtimeProtocolVersion: .legacyV1
        )
        #expect(!forgedLegacy.supportsSynchronizedDrafts)
    }

    @Test
    func advertisedDraftCapabilityWithoutExactLimitFailsClosed() throws {
        let payload = capabilityJSON.replacingOccurrences(
            of: #""phoneAuthentication":true"#,
            with: #""drafts":true,"phoneAuthentication":true"#
        )
        let decoded = try JSONDecoder().decode(APICapabilities.self, from: Data(payload.utf8))
        #expect(throws: LuxoraAPIError.self) { try decoded.validated() }
    }

    @Test
    func currentServerNegotiatesPreferredScopedV2() throws {
        let payload = capabilityJSON.replacingOccurrences(
            of: #""supported":[1],"preferred":1,"minimum":1"#,
            with: #""supported":[1,2],"preferred":2,"minimum":1"#
        ).replacingOccurrences(
            of: #""reconciliation":[1]"#,
            with: #""reconciliation":[2]"#
        )
        let decoded = try JSONDecoder().decode(APICapabilities.self, from: Data(payload.utf8))
        #expect(try decoded.validated().realtimeProtocolVersion == .scopedV2)
    }

    @Test
    func v2WithoutReconciliationFallsBackToAdvertisedV1() throws {
        var payload = capabilityJSON.replacingOccurrences(
            of: #""supported":[1],"preferred":1,"minimum":1"#,
            with: #""supported":[1,2],"preferred":2,"minimum":1"#
        ).replacingOccurrences(
            of: #""reconciliation":[1]"#,
            with: #""reconciliation":[2]"#
        )
        payload = payload.replacingOccurrences(
            of: #""reconciliation":true"#,
            with: #""reconciliation":false"#
        )
        let decoded = try JSONDecoder().decode(APICapabilities.self, from: Data(payload.utf8))
        #expect(try decoded.validated().realtimeProtocolVersion == .legacyV1)
    }

    @Test
    func v2WithoutReconciliationV2FallsBackToAdvertisedV1() throws {
        let payload = capabilityJSON.replacingOccurrences(
            of: #""supported":[1],"preferred":1,"minimum":1"#,
            with: #""supported":[1,2],"preferred":2,"minimum":1"#
        )
        let decoded = try JSONDecoder().decode(APICapabilities.self, from: Data(payload.utf8))
        #expect(try decoded.validated().realtimeProtocolVersion == .legacyV1)
    }

    @Test
    func serverMinimumAboveClientSupportRequiresUpgrade() throws {
        let payload = capabilityJSON.replacingOccurrences(
            of: #""supported":[1],"preferred":1,"minimum":1"#,
            with: #""supported":[3],"preferred":3,"minimum":3"#
        )
        let decoded = try JSONDecoder().decode(APICapabilities.self, from: Data(payload.utf8))
        #expect(throws: LuxoraAPIError.self) {
            try decoded.validated()
        }
    }

    @Test
    func securityCriticalCompatibilityMismatchRequiresUpgrade() throws {
        let payload = capabilityJSON.replacingOccurrences(
            of: #""securityCriticalIncompatibility":"required_upgrade""#,
            with: #""securityCriticalIncompatibility":"ignore""#
        )
        let decoded = try JSONDecoder().decode(APICapabilities.self, from: Data(payload.utf8))

        #expect(throws: LuxoraAPIError.self) {
            try decoded.validated()
        }
    }

    @Test(arguments: [
        (#""maxChatFolders":10"#, #""maxChatFolders":11"#),
        (#""maxChatFolderTitleLength":48"#, #""maxChatFolderTitleLength":47"#),
        (#""maxChatFolderOverrides":100"#, #""maxChatFolderOverrides":101"#),
        (#""chatFolderIdempotencyTtlSeconds":86400"#, #""chatFolderIdempotencyTtlSeconds":86399"#),
        (#""maxChatFolderActiveCommandReceipts":64"#, #""maxChatFolderActiveCommandReceipts":63"#),
    ])
    func folderCapabilityLimitMismatchFailsClosed(original: String, replacement: String) throws {
        let payload = capabilityJSON.replacingOccurrences(of: original, with: replacement)
        let decoded = try JSONDecoder().decode(APICapabilities.self, from: Data(payload.utf8))
        #expect(throws: LuxoraAPIError.self) { try decoded.validated() }
    }

    @Test
    func unavailableContractNeverPresentsServerAreasAsWorking() {
        let matrix = LuxoraFeatureMatrix(capabilityState: .unavailable("offline"))

        #expect(matrix.chats.state == .unavailable)
        #expect(matrix.identityAccess.state == .unavailable)
        #expect(matrix.mediaFiles.state == .unavailable)
        #expect(matrix.realtime.state == .unavailable)
        #expect(matrix.calls.state == .unavailable)
        #expect(matrix.stories.state == .unavailable)
    }

    private func decodeCapabilities() throws -> APICapabilities {
        try JSONDecoder().decode(APICapabilities.self, from: Data(capabilityJSON.utf8))
    }

    private var capabilityJSON: String {
        #"{"schemaVersion":1,"versions":{"http":[1],"reconciliation":[1],"realtime":{"supported":[1],"preferred":1,"minimum":1}},"identityContractVersion":1,"trust":{"profile":"cloud_preview","contentReadableByServer":true,"endToEndEncryption":false},"features":{"phoneAuthentication":true,"passwordAuthentication":true,"deviceSessions":true,"messaging":true,"identityAccess":true,"safetyReports":true,"realtime":true,"reconciliation":true,"chatFolders":true,"mediaUploads":true,"serverSearchConfigured":false,"calls":false,"passkeys":false,"push":false},"limits":{"maxMessageCodePoints":10000,"maxAttachmentsPerMessage":10,"maxAttachmentBytes":104857600,"maxChatFolders":10,"maxChatFolderTitleLength":48,"maxChatFolderOverrides":100,"chatFolderIdempotencyTtlSeconds":86400,"maxChatFolderActiveCommandReceipts":64},"compatibility":{"additiveResponseFields":"ignore","unknownMutationFields":"reject","securityCriticalIncompatibility":"required_upgrade","realtimeBelowMinimum":"no_downgrade"}}"#
    }
}
