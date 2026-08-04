import { SetPasswordForm } from "@/components/SetPasswordForm";

export default function ContributorSetPasswordPage() {
  return <SetPasswordForm redirectTo="/contributor" loginHref="/contributor/login" />;
}
