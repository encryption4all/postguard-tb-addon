import { PostGuardError } from "@e4a/pg-js";

export { PostGuardError };

export class RecipientUnknownError extends PostGuardError {
  constructor() {
    super("Recipient identifier not found in header");
    this.name = "RecipientUnknownError";
  }
}

export class DecryptionFailedError extends PostGuardError {
  constructor(message = "Decryption failed — wrong attributes") {
    super(message);
    this.name = "DecryptionFailedError";
  }
}

export class NoPublicKeyError extends PostGuardError {
  constructor() {
    super("No public key available");
    this.name = "NoPublicKeyError";
  }
}

export class SessionError extends PostGuardError {
  constructor(message = "Yivi session failed") {
    super(message);
    this.name = "SessionError";
  }
}
