import { redirect } from "next/navigation";

/** V1 kept this route; V2 renamed it to /pay. Old links keep working. */
export default function SendRedirect() {
  redirect("/pay");
}
