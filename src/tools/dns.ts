import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CpanelClient } from "../cpanel-api.js";
import { handleToolCall, formatData, formatSuccess } from "../tool-helpers.js";
import { validateDomain } from "../validation.js";

export function registerDnsTools(server: McpServer, client: CpanelClient) {
  server.tool(
    "get_dns_records",
    "Get all DNS records for a domain zone in cPanel.",
    { domain: z.string().describe("Domain name to inspect. Example: 'example.com' or 'sub.example.com'.") },
    async ({ domain }) =>
      handleToolCall(async () => {
        const zone = validateDomain(domain);
        const data = await client.api2("ZoneEdit", "fetchzone_records", { domain: zone });
        return formatData(data);
      })
  );

  server.tool(
    "add_dns_record",
    "Add a DNS zone record such as A, AAAA, CNAME, MX, TXT, SRV, or CAA.",
    {
      domain: z.string().describe("Domain/zone name. Example: 'example.com'."),
      name: z.string().describe("Record name. Example: 'blog', 'blog.example.com.', '@', or '_acme-challenge'."),
      type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "SRV", "CAA"]).describe("DNS record type. Example: 'A', 'CNAME', 'TXT', or 'MX'."),
      address: z.string().describe("Record value. Example A: '1.2.3.4', CNAME: 'target.example.com.', TXT: 'google-site-verification=abc123'."),
      ttl: z.string().default("14400").describe("TTL in seconds. Example: '300' or '14400'."),
      priority: z.string().optional().describe("Priority/preference value, mainly used for MX and SRV. Example: '10'."),
      class: z.string().default("IN").describe("DNS class. Usually 'IN'."),
    },
    async ({ domain, name, type, address, ttl, priority, class: recordClass }) =>
      handleToolCall(async () => {
        const zone = validateDomain(domain);
        const params: Record<string, string> = {
          domain: zone,
          name,
          type,
          ttl,
          class: recordClass,
        };

        if (type === "CNAME") {
          params.cname = address;
        } else if (type === "TXT") {
          params.txtdata = address;
        } else if (type === "MX") {
          params.exchange = address;
          if (priority) params.preference = priority;
        } else {
          params.address = address;
          if (priority) params.preference = priority;
        }

        const data = await client.api2("ZoneEdit", "add_zone_record", params);
        return formatSuccess(`DNS ${type} record added: ${name} → ${address}`, data);
      })
  );

  server.tool(
    "edit_dns_record",
    "Edit an existing DNS zone record",
    {
      domain: z.string().describe("Domain/zone name"),
      line: z.string().describe("Line number of the record to edit (from get_dns_records)"),
      name: z.string().describe("Record name"),
      type: z.string().describe("Record type"),
      address: z.string().describe("New record value"),
      ttl: z.string().default("14400").describe("TTL in seconds"),
    },
    async ({ domain, line, name, type, address, ttl }) =>
      handleToolCall(async () => {
        const zone = validateDomain(domain);
        const params: Record<string, string> = {
          domain: zone,
          Line: line,
          name,
          type,
          ttl,
        };

        if (type === "CNAME") {
          params.cname = address;
        } else if (type === "TXT") {
          params.txtdata = address;
        } else if (type === "MX") {
          params.exchange = address;
        } else {
          params.address = address;
        }

        const data = await client.api2("ZoneEdit", "edit_zone_record", params);
        return formatSuccess(`DNS record updated on line ${line}`, data);
      })
  );

  server.tool(
    "delete_dns_record",
    "Delete a DNS zone record by line number",
    {
      domain: z.string().describe("Domain/zone name"),
      line: z.string().describe("Line number of the record to delete (from get_dns_records)"),
    },
    async ({ domain, line }) =>
      handleToolCall(async () => {
        const zone = validateDomain(domain);
        const data = await client.api2("ZoneEdit", "remove_zone_record", {
          domain: zone,
          line,
        });
        return formatSuccess(`DNS record on line ${line} deleted from ${zone}`, data);
      })
  );
}
