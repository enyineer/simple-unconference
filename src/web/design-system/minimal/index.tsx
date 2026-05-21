// Minimal plugin registration.
//
// Component definitions live in `./components`. This file only assembles
// them into the plugin object so the components file stays Fast-Refresh-
// friendly (react-refresh/only-export-components requires that files mixing
// component and non-component exports be split this way).

import type { DesignSystem } from "../core/contract";
import {
  ThemeProvider, PageLayout, Heading, Text, Link, Button,
  TextInput, Textarea, Select, Card, Stack, Banner, Form, Spinner, Badge,
  Sheet, DateTime,
} from "./components";

export const minimal: DesignSystem = {
  id: "minimal",
  label: "Minimal",
  ThemeProvider, PageLayout, Heading, Text, Link, Button,
  TextInput, Textarea, Select, Card, Stack, Banner, Form, Spinner, Badge,
  Sheet, DateTime,
};
