// Per-conference identity login. Reached when a participant lands on
// /c/<slug>/login (either by typing the URL or because they tried to open
// /conferences/<slug> without a valid identity cookie).
//
// This is *not* the same as the global owner login at /. An identity is
// scoped to one conference and its cookie name is uncon_session_<confId>.

import { useState } from "react";
import {
  Button, Card, Form, Heading, Link, PageLayout, Stack, Text, TextInput,
} from "../design-system";
import { useToast } from "../design-system/hooks";
import { api, errorCode, errorFields } from "../api";
import { useForm } from "../useForm";
import { ConfLoginSchema, safeParse } from "../../shared/schemas";

export function ConferenceLoginPage({
  slug, onLoggedIn, onCancel,
}: {
  slug: string;
  onLoggedIn: () => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const form = useForm(ConfLoginSchema, { email: "", password: "" });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = safeParse(ConfLoginSchema, form.values);
    if (!r.ok) { form.setErrors(r.errors); return; }
    setBusy(true);
    try {
      await api.conferences.login({ slug, ...r.data });
      onLoggedIn();
    } catch (err) {
      const fields = errorFields(err);
      if (fields) form.setErrors(fields);
      else toast.error(humanError(errorCode(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageLayout>
      <Stack gap="spacious">
        <Heading level={1}>Sign in to this conference</Heading>

        <Card title="Sign in">
          <Text muted>
            Use the email + password you set when you joined this conference.
            Other conferences use separate accounts.
          </Text>
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
            <Stack direction="row" gap="condensed" align="center">
              <Button type="submit" variant="primary" disabled={busy}>
                Sign in
              </Button>
              <Link href="#" onClick={(e) => { e.preventDefault(); onCancel(); }}>
                Back
              </Link>
            </Stack>
          </Form>
        </Card>
      </Stack>
    </PageLayout>
  );
}

function humanError(code: string): string {
  return ({
    invalid_credentials: "Wrong email or password.",
    conference_not_found: "We couldn't find that conference.",
  } as Record<string, string>)[code] ?? code;
}
