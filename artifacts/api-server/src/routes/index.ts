import { Router, type IRouter } from "express";
import healthRouter from "./health";
import redesignsRouter from "./redesigns";
import visualRequestsRouter from "./visual-requests";
import benchmarkWidgetRouter from "./benchmark-widget";

const router: IRouter = Router();

router.use(healthRouter);
router.use(redesignsRouter);
router.use(visualRequestsRouter);
router.use(benchmarkWidgetRouter);

export default router;
