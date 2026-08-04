import XCTest
@testable import LuxoraKit

final class APIPathTests: XCTestCase {
    func testUUIDPathComponentUsesServerCanonicalLowercase() throws {
        let id = try XCTUnwrap(UUID(uuidString: "BC692927-6287-4566-B3CA-D6E1A68254DC"))

        XCTAssertEqual(id.apiPathComponent, "bc692927-6287-4566-b3ca-d6e1a68254dc")
    }
}
