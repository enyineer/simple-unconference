import { useState } from "react";
import {
  PageLayout, Heading, Stack, Card, TextInput, Button, Form, Banner, Link, Text,
} from "../design-system";
import { api, ApiError, errorCode, errorFields } from "../api";
import { useForm } from "../useForm";
import { LoginSchema, SignupSchema, safeParse } from "../../shared/schemas";

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [topError, setTopError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Same field set, two schemas — pick at submit time.
  const form = useForm(SignupSchema, { email: "", password: "", name: "" });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTopError(null);
    // Validate against whichever schema matches the active mode. For login we
    // only need email + password; for signup we additionally accept `name`.
    const r = mode === "login"
      ? safeParse(LoginSchema, { email: form.values.email, password: form.values.password })
      : safeParse(SignupSchema, form.values);
    if (!r.ok) {
      form.setErrors(r.errors);
      return;
    }

    setBusy(true);
    try {
      if (mode === "login") {
        await api.auth.login(r.data as { email: string; password: string });
      } else {
        await api.auth.signup(r.data as { email: string; password: string; name?: string });
      }
      onLoggedIn();
    } catch (e) {
      const fields = errorFields(e);
      if (fields) form.setErrors(fields);
      else setTopError(humanError(errorCode(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageLayout>
      <Stack gap="spacious">
        <Heading level={1}>simple-unconference</Heading>

        <Card title={mode === "login" ? "Sign in" : "Create account"}>
          {topError && <Banner variant="critical">{topError}</Banner>}
          <Form onSubmit={submit}>
            <TextInput
              label="Email" type="email" required
              value={form.values.email ?? ""}
              onChange={(e) => form.setValue("email", e.target.value)}
              error={form.fieldError("email")}
            />
            <TextInput
              label="Password" type="password" required
              value={form.values.password ?? ""}
              onChange={(e) => form.setValue("password", e.target.value)}
              error={form.fieldError("password")}
            />
            {mode === "signup" && (
              <TextInput
                label="Name (optional)"
                value={form.values.name ?? ""}
                onChange={(e) => form.setValue("name", e.target.value)}
                error={form.fieldError("name")}
              />
            )}
            <Stack direction="row" gap="condensed" align="center">
              <Button type="submit" variant="primary" disabled={busy}>
                {mode === "login" ? "Sign in" : "Create account"}
              </Button>
              <Text muted>
                {mode === "login" ? "No account?" : "Already have one?"}{" "}
                <Link
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    setMode(mode === "login" ? "signup" : "login");
                    setTopError(null);
                    form.setErrors({});
                  }}
                >
                  {mode === "login" ? "Sign up" : "Sign in"}
                </Link>
              </Text>
            </Stack>
          </Form>
        </Card>
      </Stack>
    </PageLayout>
  );
}

function humanError(code: string): string {
  return {
    invalid_credentials: "Wrong email or password.",
    email_taken: "Email is already registered.",
  }[code] ?? code;
}
