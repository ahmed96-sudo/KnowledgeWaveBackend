-- AlterTable
ALTER TABLE "instructors" ADD COLUMN     "position" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "position" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "courses" ADD COLUMN     "position" SERIAL NOT NULL,
ADD COLUMN     "searchMeta" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "searchText" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "reviews" ADD COLUMN     "position" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "roadmaps" ADD COLUMN     "position" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "testimonials" ADD COLUMN     "position" SERIAL NOT NULL;

