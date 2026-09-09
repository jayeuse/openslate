import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

// Auth URLs, cookies and assertion payloads must not enter CI artifacts.
export default class SafeReporter implements Reporter {
  onTestEnd(test: TestCase, result: TestResult) {
    console.log(JSON.stringify({ test: test.title, status: result.status }));
  }
}
