import { createMetaRouter } from "@twasik4/pocket-service";
import z from "zod";

const { addRoute } = createMetaRouter();

addRoute(
  {
    method: "GET",
    fullPath: "/:id",
    paramsValidator: z.object({ id: z.string() }),
  },
  (req, res) => {
    const id: string = req.params.id;
    const requestId: string = req.id;
    // @ts-expect-error req.params.id is a string; this only errors if req is typed.
    const notNumber: number = req.params.id;
    // @ts-expect-error res is an Express Response; this only errors if res is typed.
    const notString: string = res;
    res.json({ id, requestId, notNumber, notString });
  },
);
