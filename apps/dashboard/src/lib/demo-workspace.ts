/**
 * Demo workspace context management.
 */

export const DEMO_PROJECT_ID = "demo";
const COOKIE_NAME = "active-project";

/** Enter demo workspace — navigate to demo project. */
export function enterDemo() {
  document.cookie = `${COOKIE_NAME}=${DEMO_PROJECT_ID};path=/;max-age=604800;samesite=lax`;
  window.location.href = `/project/${DEMO_PROJECT_ID}/tasks`;
}
