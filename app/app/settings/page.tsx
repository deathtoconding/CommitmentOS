import { AppSectionPage, type AppSearchParams } from '@/app-shell/section-page';

type SettingsPageProps = {
  searchParams: Promise<AppSearchParams>;
};

export default function SettingsPage({ searchParams }: SettingsPageProps) {
  return <AppSectionPage section="settings" searchParams={searchParams} />;
}
