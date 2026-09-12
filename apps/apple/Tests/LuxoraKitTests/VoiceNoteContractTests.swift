import Foundation
import Testing
@testable import LuxoraKit

struct VoiceNoteContractTests {
    #if os(iOS)
    @Test func downsampleKeepsPeaksWithinServerBounds() {
        let levels = Array(0..<500)
        let downsampled = PhoneVoiceRecorder.downsampled(levels, to: 100)
        #expect(downsampled.count == 100)
        #expect(downsampled.allSatisfy { $0 >= 0 && $0 <= 255 })
        #expect(downsampled.max() == 499)
    }

    @Test func downsamplePassesThroughShortRecordings() {
        #expect(PhoneVoiceRecorder.downsampled([], to: 100) == [])
        #expect(PhoneVoiceRecorder.downsampled([10, 20, 30], to: 100) == [10, 20, 30])
    }
    #endif

    @Test func attachmentDecodesDurationAndWaveformMetadata() throws {
        let payload = """
        {"id":"\(UUID().uuidString.lowercased())","kind":"voice","fileName":"voice-note.m4a",\
        "mimeType":"audio/mp4","sizeBytes":4096,"sha256":"\(String(repeating: "a", count: 64))",\
        "downloadPath":"/v1/attachments/\(UUID().uuidString.lowercased())/content",\
        "safetyStatus":"unscanned","metadataTrust":"client_declared",\
        "createdAt":"2026-09-12T00:00:00.000Z",\
        "metadata":{"durationMs":61000,"waveform":[0,128,255]}}
        """
        let decoded = try JSONDecoder().decode(APIAttachment.self, from: Data(payload.utf8))
        let attachment = decoded.attachment()
        #expect(attachment.isVoice)
        #expect(attachment.durationMs == 61_000)
        #expect(attachment.waveform == [0, 128, 255])
        #expect(attachment.formattedDuration == "1:01")
    }
    @Test func attachmentWithoutMediaMetadataStaysValid() throws {
        let payload = """
        {"id":"\(UUID().uuidString.lowercased())","kind":"file","fileName":"doc.pdf",\
        "mimeType":"application/pdf","sizeBytes":1024,"sha256":"\(String(repeating: "b", count: 64))",\
        "downloadPath":"/v1/attachments/\(UUID().uuidString.lowercased())/content",\
        "safetyStatus":"unscanned","metadataTrust":"client_declared",\
        "createdAt":"2026-09-12T00:00:00.000Z","metadata":{}}
        """
        let decoded = try JSONDecoder().decode(APIAttachment.self, from: Data(payload.utf8))
        #expect(!decoded.attachment().isVoice)
        #expect(decoded.attachment().formattedDuration == nil)
    }

    @Test func messageDecodesTranscriptConsentContract() throws {
        let sender = """
        {"id":"00112233-4455-4677-8899-aabbccddeeff","username":"voice_sender",\
        "displayName":"Voice Sender","bio":"","avatarUrl":null,\
        "createdAt":"2026-09-12T00:00:00.000Z","lastSeenAt":null}
        """
        let payload = """
        {"id":"00112233-4455-4677-8899-aabbccddeeff","chatId":"00112233-4455-4677-8899-aabbccddeeff",\
        "sender":\(sender),"kind":"media","body":null,"replyToMessageId":null,\
        "topicId":null,"forwardedFrom":null,"attachments":[],\
        "transcriptionAllowed":true,"transcript":"Текст расшифровки",\
        "isPinned":false,"clientNonce":"00112233-4455-4677-8899-aabbccddeeff",\
        "revision":0,"createdAt":"2026-09-12T00:00:00.000Z",\
        "updatedAt":"2026-09-12T00:00:00.000Z","editedAt":null,"deletedAt":null}
        """
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(APIMessage.self, from: Data(payload.utf8))
        let viewer = UUID()
        let message = decoded.message(currentUserID: viewer)
        #expect(message.transcriptionAllowed)
        #expect(message.transcript == "Текст расшифровки")
    }

    @Test func transcriptRequestBodyCarriesLowercaseIdentifiers() throws {
        let messageID = try #require(UUID(uuidString: "00112233-4455-4677-8899-AABBCCDDEEFF"))
        let nonce = try #require(UUID(uuidString: "11223344-5566-4788-99AA-BBCCDDEEFF00"))
        let body = ["text": "Текст", "clientNonce": nonce.apiPathComponent]
        let data = try JSONSerialization.data(withJSONObject: body)
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: String])
        #expect(json["clientNonce"] == "11223344-5566-4788-99aa-bbccddeeff00")
        #expect(messageID.apiPathComponent == "00112233-4455-4677-8899-aabbccddeeff")
    }
}
