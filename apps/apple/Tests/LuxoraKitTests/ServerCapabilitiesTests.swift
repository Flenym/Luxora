import Foundation
import Testing
@testable import LuxoraKit

struct ServerCapabilitiesTests {
    @Test
    func currentContractMapsOnlyAdvertisedFeatures() throws {
        let capabilities = try decodeCapabilities().validated()
        let matrix = LuxoraFeatureMatrix(capabilityState: .available(capabilities))

        #expect(capabilities.features.phoneAuthentication)
        #expect(matrix.chats.state == .available)
        #expect(matrix.mediaFiles.state == .limited)
        #expect(matrix.realtime.state == .limited)
        #expect(matrix.calls.state == .unavailable)
        #expect(matrix.pushJobs.state == .unavailable)
        #expect(matrix.securityE2EE.state == .unavailable)
        #expect(matrix.communities.state == .unavailable)
        #expect(matrix.stories.state == .unavailable)
        #expect(matrix.allSections.count == 12)
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
        #"{"schemaVersion":1,"versions":{"http":[1],"reconciliation":[1],"realtime":{"supported":[1],"preferred":1,"minimum":1}},"identityContractVersion":1,"trust":{"profile":"cloud_preview","contentReadableByServer":true,"endToEndEncryption":false},"features":{"phoneAuthentication":true,"passwordAuthentication":true,"deviceSessions":true,"messaging":true,"identityAccess":true,"safetyReports":true,"realtime":true,"reconciliation":true,"mediaUploads":true,"serverSearchConfigured":false,"calls":false,"passkeys":false,"push":false},"limits":{"maxMessageCodePoints":10000,"maxAttachmentsPerMessage":10,"maxAttachmentBytes":104857600},"compatibility":{"additiveResponseFields":"ignore","unknownMutationFields":"reject","securityCriticalIncompatibility":"required_upgrade","realtimeBelowMinimum":"no_downgrade"}}"#
    }
}
