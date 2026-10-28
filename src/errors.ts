/** Errors exposed by the materializer contract. */
export class ProfileError extends Error {
  override readonly name = "ProfileError";
}

/** A provider proved that the selected remote bundle does not exist. */
export class BundleNotFoundError extends Error {
  override readonly name = "BundleNotFoundError";
}

/** A provider cannot handle the selected source kind or repository. */
export class ProviderUnsupportedError extends Error {
  override readonly name = "ProviderUnsupportedError";
}

/** A provider failed without proving that the selected bundle is absent. */
export class BundleFetchError extends Error {
  override readonly name = "BundleFetchError";
}

/** Runtime bytes differ from the canonical profile. */
export class DigestMismatchError extends Error {
  override readonly name = "DigestMismatchError";
}

/** The native plugin state differs from the canonical profile or receipt. */
export class DriftError extends Error {
  override readonly name = "DriftError";
}

/** A staged replacement failed and the original state was restored. */
export class ReplacementError extends Error {
  override readonly name = "ReplacementError";
}

/** Another process owns the target vault state. */
export class OperationLockedError extends Error {
  override readonly name = "OperationLockedError";
}
