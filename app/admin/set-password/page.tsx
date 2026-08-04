import { SetPasswordForm } from "@/components/SetPasswordForm";

export default function AdminSetPasswordPage() {
  return <SetPasswordForm redirectTo="/admin" loginHref="/admin/login" />;
}
