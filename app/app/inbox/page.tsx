import { AppSectionPage, type AppSearchParams } from '@/app-shell/section-page';

type InboxPageProps = {
  searchParams: Promise<AppSearchParams>;
};

export default function InboxPage({ searchParams }: InboxPageProps) {
  return <AppSectionPage section="inbox" searchParams={searchParams} />;
}
