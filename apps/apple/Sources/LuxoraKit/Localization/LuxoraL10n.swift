import Foundation

/// Production strings are resolved from the Swift Package resource bundle.
/// Russian is the package development language and therefore the fallback even
/// when the host application or Simulator has no explicit locale override.
public enum LuxoraL10n {
    public static func text(_ key: String) -> String {
        String(
            localized: String.LocalizationValue(key),
            table: "Localizable",
            bundle: .module
        )
    }

    public static var developmentLocalization: String? {
        Bundle.module.developmentLocalization
    }
}
