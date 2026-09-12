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
}
