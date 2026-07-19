import Link from "next/link";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPage } from "@/components/status-page";

export default function NotFound() {
  return (
    <StatusPage
      badge="404"
      icon={<Compass className="size-8 text-primary" />}
      title="Page not found"
      description="The page you're looking for doesn't exist or may have moved. Check the URL or head back to the dashboard."
    >
      <div className="flex flex-wrap gap-2">
        <Button type="button" asChild>
          <Link href="/">Go to dashboard</Link>
        </Button>
      </div>
    </StatusPage>
  );
}
