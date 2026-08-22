export default function PrivacyPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-16 text-slate-800 dark:text-slate-200">
      <h1 className="text-3xl font-bold mb-2">Privacy Policy</h1>
      <p className="text-sm text-slate-500 mb-10">Last updated: August 13, 2026</p>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">1. Overview</h2>
        <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          TestMind AI ("we", "us", or "our") operates the TestMind platform, including our web application
          and any associated mobile applications (collectively, the "Service"). This Privacy Policy explains
          what information we collect, how we use it, and your rights regarding that information.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">2. Information We Collect</h2>
        <ul className="text-sm leading-relaxed text-slate-600 dark:text-slate-400 space-y-2 list-disc ml-5">
          <li><strong>Account information:</strong> Name and email address provided during sign-up, managed via Clerk authentication.</li>
          <li><strong>Usage data:</strong> Pages visited, features used, and actions taken within the Service.</li>
          <li><strong>Project data:</strong> Test cases, test suites, URLs, and configuration you create or import.</li>
          <li><strong>Test execution data:</strong> Results, logs, screenshots, and reports generated when running tests.</li>
          <li><strong>Billing information:</strong> Subscription and payment data processed by Stripe. We do not store raw card numbers.</li>
          <li><strong>Device &amp; log data:</strong> IP address, browser type, OS, and error logs collected automatically.</li>
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">3. How We Use Your Information</h2>
        <ul className="text-sm leading-relaxed text-slate-600 dark:text-slate-400 space-y-2 list-disc ml-5">
          <li>To provide, operate, and improve the Service.</li>
          <li>To generate AI-powered test cases using OpenAI's API on your behalf.</li>
          <li>To process payments and manage your subscription.</li>
          <li>To send transactional emails (e.g. run completions, alerts). We do not send unsolicited marketing without consent.</li>
          <li>To diagnose errors and ensure security of the platform.</li>
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">4. Third-Party Services</h2>
        <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-400 mb-2">
          We use the following third-party processors. Each operates under its own privacy policy:
        </p>
        <ul className="text-sm leading-relaxed text-slate-600 dark:text-slate-400 space-y-1 list-disc ml-5">
          <li><strong>Clerk</strong> — authentication and user identity</li>
          <li><strong>Stripe</strong> — payment processing and subscription management</li>
          <li><strong>OpenAI</strong> — AI test generation (your project data may be sent to OpenAI to generate tests)</li>
          <li><strong>Railway</strong> — cloud infrastructure and hosting</li>
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">5. Data Retention</h2>
        <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          We retain your account and project data for as long as your account is active. Test run logs and
          reports are retained for 90 days by default. You may request deletion of your data at any time
          by contacting us.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">6. Data Security</h2>
        <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          We use industry-standard encryption (TLS in transit, AES-256 at rest) and access controls to
          protect your data. Credentials you provide for authenticated URL scanning are used only for the
          duration of that scan request and are never stored or logged.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">7. Your Rights</h2>
        <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          Depending on your location, you may have rights to access, correct, export, or delete your
          personal data. To exercise these rights, email us at the address below. We will respond within
          30 days.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">8. Children's Privacy</h2>
        <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          The Service is not directed to children under 13. We do not knowingly collect personal
          information from children.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">9. Changes to This Policy</h2>
        <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          We may update this policy from time to time. When we do, we will revise the "Last updated"
          date above. Continued use of the Service after changes constitutes acceptance.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">10. Contact</h2>
        <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          Questions about this policy? Contact us at:{" "}
          <a href="mailto:johnfarmer43@gmail.com" className="text-blue-600 underline">
            johnfarmer43@gmail.com
          </a>
        </p>
      </section>
    </div>
  );
}
