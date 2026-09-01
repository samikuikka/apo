export type PasswordChecks = {
  minLength: boolean
  hasLetter: boolean
  hasNumber: boolean
}

/**
 * Client-side password strength preview for the auth forms.
 * Mirrors the backend's `validate_password_strength`: at least 8
 * characters, one letter, one number. The backend remains the
 * authority — this only drives the requirement checklist.
 */
export function validatePassword(password: string): PasswordChecks {
  return {
    minLength: password.length >= 8,
    hasLetter: /[a-zA-Z]/.test(password),
    hasNumber: /\d/.test(password),
  }
}
