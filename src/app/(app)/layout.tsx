import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { UserBottomNav, UserNavbar } from "@/components/user-nav";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <div className="flex min-h-screen flex-col">
      <UserNavbar />
      {user.status !== "ACTIVE" && (
        <div
          className={`px-4 py-2 text-center text-sm font-medium ${
            user.status === "SUSPENDED"
              ? "bg-[#fff6e0] text-[#8a5a00]"
              : "bg-[#fdecea] text-[#b3261e]"
          }`}
        >
          {user.status === "SUSPENDED"
            ? "Your account is suspended. You cannot send Aeros until it is restored."
            : "Your account is banned. You cannot send or receive Aeros."}
        </div>
      )}
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-20 pt-6 sm:px-6 sm:pb-10">
        {children}
      </main>
      <UserBottomNav />
    </div>
  );
}
